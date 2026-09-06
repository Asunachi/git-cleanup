// Seeded differential fuzz for the delete-time guards.
//
// The safety contract of prune is: a branch is only ever deleted at the
// exact state the scan analyzed. This fuzz attacks that contract with REAL
// repositories — six merged+pushed branches against a bare origin — by
// mutating branches BETWEEN the scan and the prune, exactly like a force
// push, rebase, `fetch --prune`, or another machine's push landing while
// the user is about to delete:
//
//   local:  commit on top   (SHA moves, new work)
//           reset older     (SHA moves, branch rewound)
//           disappear       (branch deleted elsewhere)
//   remote: advance + fetch (tracking ref moves to the new SHA)
//           advance, no fetch (server moves; lease must refuse the push)
//           tracking ref gone (batch abort with a plain error)
//           server-deleted  (already gone server-side -> prune stale ref)
//
// Every case exercises EVERY mutation kind (shuffled arrangement), and
// the oracle asserts the one invariant that must never break: any branch
// whose state differs from what the scan saw is never deleted, and its
// post-mutation work is still reachable afterwards.
//
//   PRUNE_FUZZ_CASES=20 PRUNE_FUZZ_SEED=12345 node --test test/prune-guard-fuzz.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DAY, commit, merge, sh } from "../support/helpers.mjs";
import { analyzeRepo } from "../src/analyze.mjs";
import { pruneRepo } from "../src/prune.mjs";
import { defaults, VERDICTS } from "../src/classify.mjs";

// ---- seeded PRNG (mulberry32) ----------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rand, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// One entry per fixture branch; every case uses all of them, so every kind
// is exercised in every case no matter how the PRNG arranges the order.
const LOCAL_KINDS = ["commit-on-top", "reset-older", "disappear", "unchanged", "unchanged", "unchanged"];
const REMOTE_KINDS = ["advance", "advance-no-fetch", "tracking-gone", "server-deleted", "unchanged", "unchanged"];

/**
 * Build the fuzz repo: main with six branches that were merged with
 * --no-ff and pushed, so every one is a DELETE candidate both locally and
 * on the remote. Returns { bare, work, other, branches, cleanup }.
 */
function buildRepo() {
  const base = mkdtempSync(join(tmpdir(), "gc-guardfuzz-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  const other = join(base, "other"); // "another machine" for remote pushes
  sh(null, ["init", "-q", "-b", "main", "--bare", bare]);
  sh(null, ["clone", "-q", bare, work]);
  sh(work, ["config", "user.name", "Test"]);
  sh(work, ["config", "user.email", "test@example.com"]);

  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { date: now - 110 * DAY, msg: "initial" });
  const branches = [];
  for (let i = 0; i < 6; i++) {
    const name = `fuzz/${String.fromCharCode(97 + i)}`; // fuzz/a .. fuzz/f
    commit(work, name, { [`work-${i}.txt`]: "1" }, { date: now - 100 * DAY, msg: `work ${i}` });
    merge(work, "main", name, { date: now - 90 * DAY });
    branches.push(name);
  }
  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["push", "-q", "origin", "main"]);
  for (const b of branches) sh(work, ["push", "-q", "origin", b]);
  sh(work, ["remote", "set-head", "origin", "-a"]);

  sh(null, ["clone", "-q", bare, other]);
  sh(other, ["config", "user.name", "Test"]);
  sh(other, ["config", "user.email", "test@example.com"]);

  return {
    bare,
    work,
    other,
    branches,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Mutate one LOCAL branch per its kind, after the scan. Returns the
 * post-mutation SHA for moved kinds (the state that must survive).
 */
function mutateLocal(work, name, kind) {
  if (kind === "unchanged") return null;
  if (kind === "commit-on-top") {
    sh(work, ["checkout", "-q", name]);
    commit(work, name, { "post-scan.txt": "new work" }, { msg: "post-scan commit" });
  } else if (kind === "reset-older") {
    sh(work, ["checkout", "-q", name]);
    sh(work, ["reset", "-q", "--hard", "HEAD~1"]);
  } else if (kind === "disappear") {
    sh(work, ["checkout", "-q", "main"]);
    sh(work, ["branch", "-D", name]);
  }
  // --verify with the full ref: a short name would DWIM-resolve to the
  // still-present remote-tracking ref (refs/remotes/origin/x) after a
  // delete, making a gone branch look alive.
  return sh(work, ["rev-parse", "--verify", `refs/heads/${name}`], { allowFail: true }).out || null;
}

/**
 * Mutate one REMOTE branch per its kind, after the scan. Returns
 * { newSha } when the server-side ref changed (the state that must
 * survive), or null.
 */
function mutateRemote(work, bare, other, name, kind) {
  if (kind === "unchanged") return { newSha: null };
  if (kind === "advance" || kind === "advance-no-fetch") {
    // Another machine commits on top of the analyzed tip and pushes.
    sh(other, ["checkout", "-q", name]);
    commit(other, name, { "post-scan.txt": "new work" }, { msg: "post-scan push" });
    sh(other, ["push", "-q", "origin", name]);
    const newSha = sh(bare, ["rev-parse", "--verify", `refs/heads/${name}`]).out;
    if (kind === "advance") {
      // Our tracking ref picks the new tip up. Single-ref fetch on purpose:
      // a full `git fetch` would also RE-CREATE tracking refs deleted by
      // the tracking-gone mutation (the server still has them), silently
      // un-mutating that branch.
      sh(work, ["fetch", "-q", "origin", `refs/heads/${name}:refs/remotes/origin/${name}`]);
    }
    // advance-no-fetch: the server moved but our tracking ref did not —
    // the lease on the push must refuse the delete.
    return { newSha };
  }
  if (kind === "tracking-gone") {
    // The tracking ref vanishes locally (fetch --prune in another
    // terminal); the server branch still exists.
    sh(work, ["branch", "-rd", `origin/${name}`]);
    return { newSha: null };
  }
  if (kind === "server-deleted") {
    // The server ref is gone (web UI); our tracking ref is stale.
    sh(bare, ["update-ref", "-d", `refs/heads/${name}`]);
    return { newSha: null };
  }
  return { newSha: null };
}

const CASES = Number(process.env.PRUNE_FUZZ_CASES || 8);
const SEED = Number(process.env.PRUNE_FUZZ_SEED || 0x9e3779b9);

test(`prune guards leave moved work intact across ${CASES} seeded repos (seed ${SEED})`, async () => {
  const rand = mulberry32(SEED);
  // Structural counters: every kind must be exercised in EVERY case.
  const seen = {
    "commit-on-top": 0,
    "reset-older": 0,
    disappear: 0,
    unchanged: 0,
    advance: 0,
    "advance-no-fetch": 0,
    "tracking-gone": 0,
    "server-deleted": 0,
  };

  for (let ci = 0; ci < CASES; ci++) {
    const repo = buildRepo();
    try {
      const { bare, work, other, branches } = repo;
      const cfg = defaults();
      cfg.pr.track = false;

      // ---- the scan -------------------------------------------------------
      const analyzed = await analyzeRepo(work, cfg);
      const ctx = `case ${ci} (seed ${SEED})`;
      for (const b of branches) {
        assert.equal(
          analyzed.branches.find((x) => x.name === b)?.verdict,
          VERDICTS.DELETE,
          `${ctx}: fixture branch ${b} must be a DELETE candidate`
        );
        assert.equal(
          analyzed.branches.find((x) => x.name === `origin/${b}`)?.verdict,
          VERDICTS.DELETE,
          `${ctx}: remote branch origin/${b} must be a DELETE candidate`
        );
      }
      // ---- mutations between scan and prune ------------------------------
      const localKinds = shuffle(rand, LOCAL_KINDS);
      const remoteKinds = shuffle(rand, REMOTE_KINDS);
      const localState = new Map(); // name -> post-mutation sha | "gone" | null
      for (let i = 0; i < branches.length; i++) {
        const kind = localKinds[i];
        seen[kind]++;
        localState.set(branches[i], mutateLocal(work, branches[i], kind) ?? (kind === "disappear" ? "gone" : null));
      }
      sh(work, ["checkout", "-q", "main"]);

      const remoteState = new Map(); // name -> { newSha, kind }
      for (let i = 0; i < branches.length; i++) {
        const kind = remoteKinds[i];
        seen[kind]++;
        remoteState.set(branches[i], { ...mutateRemote(work, bare, other, branches[i], kind), kind });
      }
      const trackingGone = [...remoteState.values()].some((s) => s.kind === "tracking-gone");

      // ---- the prune ------------------------------------------------------
      const summary = await pruneRepo(analyzed, cfg, { yes: true, remote: true, silent: true });

      // ---- oracle: local branches ----------------------------------------
      for (const [name, state] of localState) {
        const ctxB = `${ctx} local ${name}`;
        if (state === null) {
          // Unchanged: the scan's evidence still holds — must be deleted.
          assert.ok(summary.deletedLocal.includes(name), `${ctxB}: unchanged branch must be deleted`);
          assert.ok(
            !summary.errors.some((e) => e.name === name),
            `${ctxB}: unchanged branch must not error (${JSON.stringify(summary.errors)})`
          );
        } else if (state === "gone") {
          assert.ok(!summary.deletedLocal.includes(name), `${ctxB}: gone branch must not be deleted`);
          const err = summary.errors.find((e) => e.name === name);
          assert.ok(err, `${ctxB}: gone branch must report an error (${JSON.stringify(summary.errors)})`);
          assert.match(err.error, /disappeared between scan and delete/);
          assert.ok(
            !sh(work, ["rev-parse", "--verify", `refs/heads/${name}`], { allowFail: true }).ok,
            `${ctxB}: branch must be gone`
          );
        } else {
          // Moved: never deleted, and the post-mutation tip survives.
          assert.ok(!summary.deletedLocal.includes(name), `${ctxB}: moved branch must not be deleted`);
          const err = summary.errors.find((e) => e.name === name);
          assert.ok(err, `${ctxB}: moved branch must report an error (${JSON.stringify(summary.errors)})`);
          assert.match(err.error, /moved since scan/, `${ctxB}: guard message for ${name}`);
          assert.equal(
            sh(work, ["rev-parse", "--verify", `refs/heads/${name}`]).out,
            state,
            `${ctxB}: post-mutation work must survive`
          );
        }
      }

      // ---- oracle: remote branches ---------------------------------------
      // A vanished tracking ref aborts the whole remote batch at the
      // backup step (nothing is deleted that run), so expectations differ.
      if (trackingGone) {
        const goneName = [...remoteState.entries()].find(([, s]) => s.kind === "tracking-gone")[0];
        assert.deepEqual(summary.deletedRemote, [], `${ctx}: batch must abort, nothing deleted remotely`);
        assert.deepEqual(summary.prunedRemote, [], `${ctx}: nothing pruned either`);
        const err = summary.errors.find((e) => e.name === "backup (remote)");
        assert.ok(err, `${ctx}: batch abort must be reported (${JSON.stringify(summary.errors)})`);
        assert.ok(err.error.includes(goneName), `${ctx}: abort must name ${goneName}: ${err.error}`);
        assert.match(err.error, /no longer resolve/);
        // Every branch the server still has must be intact — advanced or
        // not — and a server-deleted branch must stay gone.
        for (const [name, s] of remoteState) {
          const serverSha = sh(bare, ["rev-parse", "--verify", `refs/heads/${name}`], { allowFail: true }).out;
          if (s.kind === "server-deleted") {
            assert.ok(!serverSha, `${ctx}: server branch ${name} must stay gone`);
          } else {
            assert.ok(serverSha, `${ctx}: server branch ${name} must survive the aborted run`);
            if (s.newSha) assert.equal(serverSha, s.newSha, `${ctx}: advanced ${name} must keep its new work`);
          }
        }
      } else {
        for (const [name, s] of remoteState) {
          const ctxB = `${ctx} remote ${name}`;
          const tracking = `origin/${name}`;
          if (s.kind === "unchanged") {
            assert.ok(summary.deletedRemote.includes(tracking), `${ctxB}: unchanged branch must be deleted`);
          } else if (s.kind === "advance") {
            assert.ok(!summary.deletedRemote.includes(tracking), `${ctxB}: advanced branch must not be deleted`);
            const err = summary.errors.find((e) => e.name === tracking);
            assert.ok(err, `${ctxB}: advanced branch must report an error (${JSON.stringify(summary.errors)})`);
            assert.match(err.error, /moved since scan/);
            assert.equal(
              sh(bare, ["rev-parse", "--verify", `refs/heads/${name}`]).out,
              s.newSha,
              `${ctxB}: new work must survive on the server`
            );
          } else if (s.kind === "advance-no-fetch") {
            assert.ok(!summary.deletedRemote.includes(tracking), `${ctxB}: stale-lease branch must not be deleted`);
            const err = summary.errors.find((e) => e.name === tracking);
            assert.ok(err, `${ctxB}: the lease must refuse the delete (${JSON.stringify(summary.errors)})`);
            assert.ok(err.error.length > 0, `${ctxB}: refusal must carry git's reason`);
            assert.equal(
              sh(bare, ["rev-parse", "--verify", `refs/heads/${name}`]).out,
              s.newSha,
              `${ctxB}: new work must survive on the server`
            );
          } else if (s.kind === "server-deleted") {
            assert.ok(summary.prunedRemote.includes(tracking), `${ctxB}: stale tracking ref must be pruned`);
            assert.ok(!summary.deletedRemote.includes(tracking), `${ctxB}: nothing to push-delete`);
            assert.ok(
              !sh(bare, ["rev-parse", "--verify", `refs/heads/${name}`], { allowFail: true }).ok,
              `${ctxB}: server branch must stay gone`
            );
          }
        }
      }
    } finally {
      repo.cleanup();
    }
  }

  // Every mutation kind must have been exercised in every case, so the
  // oracle never passes vacuously. The unchanged controls run five times
  // per case (three local + two remote slots).
  for (const [kind, count] of Object.entries(seen)) {
    if (kind === "unchanged") continue;
    assert.equal(count, CASES, `mutation kind ${kind} must run in every case`);
  }
  assert.equal(seen.unchanged, CASES * 5, "unchanged controls must run in every slot");
});
