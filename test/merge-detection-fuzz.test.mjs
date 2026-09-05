// Seeded differential fuzz for merge detection.
//
// Builds random REAL repositories — commit / merge / squash / revert / noop /
// diverge operations against a bare origin, exactly like a user's history —
// then runs the analyzer and compares every branch against the oracle model
// that generated the history. The oracle knows each branch's true fate, so
// any drift in ancestry detection (mergedShaSet), content detection
// (isContentMerged), or the verdict layering (classifyBranch) fails loudly
// with the reproducing seed.
//
//   MERGE_FUZZ_CASES=40 MERGE_FUZZ_SEED=12345 node --test test/merge-detection-fuzz.test.mjs
//
// Default is 15 cases (each case is a handful of real git subprocesses); the
// fixed default seed keeps failures reproducible.
//
// Oracle precision: content-merge detection fires when the branch's FINAL
// TREE appears in base history. A squash-merged branch therefore only matches
// when it forked from main's current tip and was squashed immediately (the
// squash commit's tree is then byte-identical to the branch tip's). The
// generator restricts squash branches to that shape on purpose — anything
// else would be a genuine miss of the detection, and the fuzz must not
// assert behavior the tool does not claim to have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeRepo } from "../src/analyze.mjs";
import { defaults, VERDICTS } from "../src/classify.mjs";
import { DAY, identEnv, merge, sh } from "../support/helpers.mjs";

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

// ---- oracle model -----------------------------------------------------------

const FATES = [
  "merged",
  "merged",
  "squash",
  "squash",
  "diverge",
  "diverge",
  "diverge",
  "diverge",
  "revert",
  "noop",
];

// Ages stay away from the 21d / 45d thresholds so boundary rounding can
// never flip a verdict: 0-10d is "young", 25-40d mid, 50-120d old.
const YOUNG_AGES = [0, 1, 3, 5, 7, 9, 10];
const MID_AGES = [25, 28, 31, 34, 37, 40];
const OLD_AGES = [50, 60, 75, 90, 110, 120];

function shuffle(rand, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickAge(rand, youngPool, oldPool) {
  const pool = rand() < 0.4 ? youngPool : oldPool;
  return pool[Math.floor(rand() * pool.length)];
}

/** What the engine MUST decide for a branch with this fate and age. */
function expectedFor(fate, ageDays) {
  const integrated = fate === "merged" || fate === "squash";
  const old = ageDays >= 21;
  if (integrated) {
    if (old) {
      return {
        integrated: true,
        verdict: VERDICTS.DELETE,
        reason: fate === "merged" ? "merged" : "squash-merged",
      };
    }
    return {
      integrated: true,
      verdict: VERDICTS.KEEP,
      reason: fate === "merged" ? "too-young" : "content-young",
    };
  }
  if (ageDays >= 45) {
    return { integrated: false, verdict: VERDICTS.WARN, reason: "stale-unmerged" };
  }
  return { integrated: false, verdict: VERDICTS.KEEP, reason: "active" };
}

/**
 * Build one random repo: four base commits, ten branches with random fates
 * and ages, ~60% of branches pushed to origin. Merged and squash branches
 * are integrated into main immediately after creation (a squash only matches
 * content detection when forked from main's current tip and squashed before
 * anything else lands). Returns { work, model, cleanup }.
 */
function buildCase(rand) {
  const base = mkdtempSync(join(tmpdir(), "gc-fuzz-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  sh(null, ["init", "-q", "-b", "main", "--bare", bare]);
  sh(null, ["clone", "-q", bare, work]);
  sh(work, ["config", "user.name", "Test"]);
  sh(work, ["config", "user.email", "test@example.com"]);

  const now = Date.now();
  // Four base commits, 10 days apart, oldest 40 days ago.
  for (let i = 0; i < 4; i++) {
    sh(work, ["checkout", "-q", "-B", "main"]);
    sh(work, ["commit", "-q", "--allow-empty", "-m", `base ${i}`], {
      env: identEnv(now - (40 - i * 10) * DAY),
    });
  }

  const fates = shuffle(rand, FATES);
  const model = [];

  for (let i = 0; i < fates.length; i++) {
    const fate = fates[i];
    const name = `fuzz/${fate}-${i}`;
    const ageDays =
      fate === "diverge" || fate === "revert" || fate === "noop"
        ? pickAge(rand, YOUNG_AGES, OLD_AGES)
        : pickAge(rand, YOUNG_AGES, MID_AGES);
    // Squash branches must fork from main's current tip (see the header);
    // others may fork from an older ancestor to keep old trees in play.
    const fork =
      fate === "squash" ? "main" : rand() < 0.3 ? `main~${1 + Math.floor(rand() * 3)}` : "main";
    sh(work, ["checkout", "-q", "-B", name, fork]);

    const files = [];
    const nCommits = 1 + Math.floor(rand() * 3);
    for (let c = 0; c < nCommits; c++) {
      const file = `${fate}-${i}-${c}.txt`;
      files.push(file);
      writeFileSync(join(work, file), `content ${i}-${c}-${Math.floor(rand() * 1e9)}`);
      sh(work, ["add", file]);
      // Oldest commit first: the tip lands exactly `ageDays` days ago.
      sh(work, ["commit", "-q", "-m", `work ${c}`], {
        env: identEnv(now - (ageDays + (nCommits - 1 - c) * 2) * DAY),
      });
    }

    if (fate === "revert") {
      // Undo everything: the tip tree equals the fork tree, which is the
      // net-empty shape the content guard must NOT flag as merged.
      for (const f of files) sh(work, ["rm", "-q", f]);
      sh(work, ["commit", "-q", "-m", "revert"], {
        env: identEnv(now - (ageDays - 1) * DAY),
      });
    } else if (fate === "noop") {
      // Empty commit: same tree as the fork point.
      sh(work, ["commit", "-q", "--allow-empty", "-m", "noop"], {
        env: identEnv(now - ageDays * DAY),
      });
    } else if (fate === "merged") {
      // Real merge right away, so the tip becomes an ancestor of main.
      merge(work, "main", name, { date: now - 2 * DAY });
    } else if (fate === "squash") {
      // Squash right away, while main's tree still matches the fork point:
      // the squash commit's tree is then byte-identical to the branch tip's.
      sh(work, ["checkout", "-q", "main"]);
      sh(work, ["merge", "-q", "--squash", name]);
      sh(work, ["commit", "-q", "-m", `Squash ${name}`], {
        env: identEnv(now - 2 * DAY),
      });
    }

    model.push({ name, fate, ageDays, pushed: false });
  }

  // Publish ~60% of branches, then set the remote HEAD like a real clone.
  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["push", "-q", "origin", "main"]);
  for (const m of model) {
    if (rand() < 0.6) {
      sh(work, ["push", "-q", "origin", m.name]);
      m.pushed = true;
    }
  }
  sh(work, ["remote", "set-head", "origin", "-a"]);

  return {
    work,
    model,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Assert one analyzed branch (local or remote) against the oracle. */
function checkBranch(b, m, ctx) {
  assert.ok(b, `${ctx}: branch was not analyzed`);
  const exp = expectedFor(m.fate, m.ageDays);
  if (exp.integrated) {
    if (m.fate === "merged") {
      assert.equal(b.merged, true, `${ctx}: ancestor merge not detected`);
    } else {
      assert.equal(b.contentMerged, true, `${ctx}: squash/rebase merge not detected`);
      assert.equal(b.merged, false, `${ctx}: squash must not look ancestor-merged`);
    }
  } else {
    assert.equal(b.merged, false, `${ctx}: never-integrated work flagged merged`);
    assert.equal(
      b.contentMerged,
      false,
      `${ctx}: net-empty/reverted work flagged content-merged`
    );
  }
  assert.equal(b.verdict, exp.verdict, `${ctx}: verdict`);
  assert.equal(b.reason, exp.reason, `${ctx}: reason`);
}

const CASES = Number(process.env.MERGE_FUZZ_CASES || 15);
const SEED = Number(process.env.MERGE_FUZZ_SEED || 0xc0ffee);

test(`merge detection matches the oracle across ${CASES} random repos (seed ${SEED})`, async () => {
  const rand = mulberry32(SEED);
  let checked = 0;
  for (let ci = 0; ci < CASES; ci++) {
    const { work, model, cleanup } = buildCase(rand);
    try {
      const cfg = defaults();
      cfg.pr.track = false;
      const r = await analyzeRepo(work, cfg);
      assert.equal(r.notGit, false, `case ${ci}: repo should analyze`);

      for (const m of model) {
        const ctx = `case ${ci} (seed ${SEED}) ${m.name} (${m.fate}, ${m.ageDays}d)`;
        const local = r.branches.find((b) => b.type === "local" && b.name === m.name);
        checkBranch(local, m, ctx);
        checked++;
        if (m.pushed) {
          const remote = r.branches.find(
            (b) => b.type === "remote" && b.name === `origin/${m.name}`
          );
          checkBranch(remote, m, `${ctx} [remote]`);
          checked++;
        }
      }
      // The analyzer never invents branches that were not created.
      for (const b of r.branches) {
        if (b.type === "local" && b.name !== "main") {
          assert.ok(
            model.some((m) => m.name === b.name),
            `case ${ci}: analyzer invented branch ${b.name}`
          );
        }
      }
    } finally {
      cleanup();
    }
  }
  // Every case contains a full permutation of all ten fates, so coverage of
  // every fate is structural; this just proves the loop really ran.
  assert.ok(checked >= CASES * 10, `checked ${checked} branches across ${CASES} cases`);
});
