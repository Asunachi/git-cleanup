// Regressions for the audit findings (all were reproduced on real repos
// before fixing):
//
//  1. Content-based merge detection flagged a branch that reverts a main
//     change as "squash-merged" merely because its tip tree matches an
//     OLDER main tree (a tree that predates the branch's fork point).
//  2. prune deleted branches using only their name: a branch that moved
//     between scan and delete (force-push, rebase, someone else's push)
//     could be force-deleted, losing the new work.
//  3. repoMeta resolved git's relative --git-common-dir against the repo
//     root instead of the caller's cwd, so running from a subdirectory put
//     backup bundles in the wrong (possibly neighboring) directory.
//
// Each test asserts the FIXED behavior and would fail on the pre-fix code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DAY, commit, identEnv, makeWorkRepo, sh } from "../support/helpers.mjs";
import { analyzeRepo } from "../src/analyze.mjs";
import { pruneRepo } from "../src/prune.mjs";
import { defaults, VERDICTS } from "../src/classify.mjs";
import { listBranches, repoMeta } from "../src/git.mjs";
import { listBackupFiles } from "../src/backup.mjs";

const repos = [];
function fixture() {
  const f = makeWorkRepo();
  repos.push(f);
  return f;
}

test.after(() => {
  for (const f of repos) f.cleanup();
});

function byName(repo, name) {
  const b = repo.branches.find((x) => x.name === name);
  assert.ok(b, `branch ${name} should exist`);
  return b;
}

/**
 * Audit repro: main receives a change; a feature branch forks AFTER the
 * change and reverts it, so its tip tree equals an older main tree (one
 * that exists in base history BEFORE the branch started). The old code
 * called that squash-merged (DELETE); the ancestry guard must not.
 */
test("content merge detection ignores trees that predate the branch fork (revert)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gc-audit-revert-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  sh(null, ["init", "-q", "-b", "main", "--bare", bare]);
  sh(null, ["clone", "-q", bare, work]);
  sh(work, ["config", "user.name", "Test"]);
  sh(work, ["config", "user.email", "test@example.com"]);
  const now = Date.now();
  try {
    commit(work, "main", { "x.txt": "1" }, { date: now - 100 * DAY, msg: "initial" });
    commit(work, "main", { "x.txt": "2" }, { date: now - 80 * DAY, msg: "main change" });

    // The revert branch: old + unmerged-looking, so the old bug was loud.
    commit(work, "feature/revert", { "x.txt": "1" }, { date: now - 60 * DAY, msg: "revert main's change" });
    // The tip tree (x=1) is the tree of the INITIAL commit — which is an
    // ancestor of the fork point, never evidence of a squash merge.

    // Positive control in the same repo: a genuine squash merge, forked
    // after the revert, must still be detected (the fix must not just turn
    // content detection off).
    commit(work, "feature/squash", { "sq.txt": "squashed" }, { date: now - 55 * DAY, msg: "squash work" });
    sh(work, ["checkout", "-q", "main"]);
    sh(work, ["merge", "-q", "--squash", "feature/squash"]);
    sh(work, ["commit", "-q", "-m", "Squash feature/squash (#1)"], {
      env: identEnv(now - 50 * DAY),
    });

    sh(work, ["push", "-q", "origin", "main"]);
    sh(work, ["push", "-q", "origin", "feature/revert"]);
    sh(work, ["push", "-q", "origin", "feature/squash"]);
    sh(work, ["remote", "set-head", "origin", "-a"]);

    const cfg = defaults();
    const repo = await analyzeRepo(work, cfg);

    const revert = byName(repo, "feature/revert");
    assert.equal(revert.merged, false);
    assert.equal(
      revert.contentMerged,
      false,
      "a branch that reverts main's change must not look squash-merged"
    );
    assert.notEqual(revert.verdict, VERDICTS.DELETE, revert.reason);

    // The remote-tracking copy is judged the same way.
    const remoteRevert = byName(repo, "origin/feature/revert");
    assert.equal(remoteRevert.contentMerged, false);
    assert.notEqual(remoteRevert.verdict, VERDICTS.DELETE);

    // And the genuine squash merge is still found and pruned.
    const squash = byName(repo, "feature/squash");
    assert.equal(squash.contentMerged, true, "genuine squash merge must still be detected");
    assert.equal(squash.verdict, VERDICTS.DELETE);

    const summary = await pruneRepo(repo, cfg, { yes: true });
    assert.ok(summary.deletedLocal.includes("feature/squash"), String(summary.deletedLocal));
    assert.ok(!summary.deletedLocal.includes("feature/revert"), String(summary.deletedLocal));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Audit repro: a branch moves between scan and prune. The local guard must
 * refuse to delete it (SHA changed), and the new work must survive.
 */
test("prune skips a local branch that moved between scan and delete", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);
    const target = byName(repo, "feature/merged-old");
    assert.equal(target.verdict, VERDICTS.DELETE);

    // Someone rewrites the branch after the scan (simulates a force-push
    // / rebase landing while the user was about to prune).
    commit(f.work, "feature/merged-old", { "new.txt": "1" }, { msg: "post-scan work" });

    const summary = await pruneRepo(repo, cfg, { yes: true });
    assert.ok(
      !summary.deletedLocal.includes("feature/merged-old"),
      String(summary.deletedLocal)
    );
    const err = summary.errors.find((e) => e.name === "feature/merged-old");
    assert.ok(err, JSON.stringify(summary.errors));
    assert.match(err.error, /moved since scan/);

    // The branch survives with the post-scan commit intact.
    const names = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(names.includes("feature/merged-old"));
    assert.ok(sh(f.work, ["cat-file", "-e", "feature/merged-old:new.txt"]).ok, "new work intact");
  } finally {
    f.cleanup();
    repos.pop();
  }
});

/**
 * Audit repro: the remote branch advances after the scan (another machine
 * pushed). The remote guard must skip it instead of deleting advanced work.
 */
test("prune skips a remote branch that advanced after the scan", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);
    const target = byName(repo, "origin/feature/merged-old2");
    assert.equal(target.verdict, VERDICTS.DELETE);

    // Another machine pushes new work on top of the analyzed tip.
    const other = join(f.base, "other");
    sh(null, ["clone", "-q", f.bare, other]);
    sh(other, ["config", "user.name", "Test"]);
    sh(other, ["config", "user.email", "test@example.com"]);
    commit(other, "feature/merged-old2", { "new.txt": "1" }, { msg: "post-scan push" });
    sh(other, ["push", "-q", "origin", "feature/merged-old2"]);
    // Our tracking ref picks the new tip up.
    sh(f.work, ["fetch", "-q", "origin"]);

    const summary = await pruneRepo(repo, cfg, { yes: true, remote: true });
    assert.ok(
      !summary.deletedRemote.includes("origin/feature/merged-old2"),
      String(summary.deletedRemote)
    );
    const err = summary.errors.find((e) => e.name === "origin/feature/merged-old2");
    assert.ok(err, JSON.stringify(summary.errors));
    assert.match(err.error, /moved since scan/);

    // The advanced branch is still on the server with its new commit.
    const heads = sh(f.bare, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]).out;
    assert.ok(heads.includes("feature/merged-old2"));
    const serverTip = sh(f.bare, ["rev-parse", "refs/heads/feature/merged-old2"]).out;
    assert.notEqual(serverTip, target.sha);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

/** The guard's remaining refusal paths: each must fail loudly, never delete. */
test("prune refuses to delete a branch that vanished between scan and prune", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);
    // The branch is gone before prune runs (deleted elsewhere).
    sh(f.work, ["branch", "-D", "feature/merged-old"]);

    const summary = await pruneRepo(repo, cfg, { yes: true });
    const err = summary.errors.find((e) => e.name === "feature/merged-old");
    assert.ok(err, JSON.stringify(summary.errors));
    assert.match(err.error, /disappeared between scan and delete/);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("prune refuses -D when an ancestor-merged branch lost its base ref", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);
    // The only base ref vanishes between scan and prune (e.g. the remote
    // default branch was renamed and the stale clone was never refreshed):
    // the branch's merge evidence is gone, so force-deleting it would be
    // deleting unproven work.
    sh(f.work, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const summary = await pruneRepo(repo, cfg, { yes: true });
    const err = summary.errors.find((e) => e.name === "feature/merged-old");
    assert.ok(err, JSON.stringify(summary.errors));
    assert.match(err.error, /no longer merged into any base branch/);
    const names = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(names.includes("feature/merged-old"));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("prune refuses a remote delete when the tracking ref is gone", async () => {
  const f = fixture();
  try {
    // Backups disabled on purpose: the bundle step would otherwise abort
    // the batch before the delete guard runs (the bundle cannot be made
    // from a ref that no longer exists). With them disabled, the guard is
    // the only thing standing between the user and a blind delete.
    const cfg = defaults();
    cfg.backup = { enabled: false };
    const repo = await analyzeRepo(f.work, cfg);
    // The tracking ref vanishes between scan and prune (e.g. a fetch
    // --prune in another terminal). Without a lease anchor the delete
    // cannot be atomic, so it must not happen at all.
    sh(f.work, ["branch", "-rd", "origin/feature/merged-old2"]);

    const summary = await pruneRepo(repo, cfg, { yes: true, remote: true });
    assert.ok(
      !summary.deletedRemote.includes("origin/feature/merged-old2"),
      String(summary.deletedRemote)
    );
    const err = summary.errors.find((e) => e.name === "origin/feature/merged-old2");
    assert.ok(err, JSON.stringify(summary.errors));
    assert.match(err.error, /cannot verify remote branch state/);
    // The server branch is untouched.
    const heads = sh(f.bare, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]).out;
    assert.ok(heads.includes("feature/merged-old2"));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

/**
 * Audit repro: repoMeta resolved git's relative --git-common-dir against
 * the repo root, so a subdirectory run pointed backups at
 * <root>/../.git/... — a neighboring project. Both the metadata and the
 * real prune-from-subdir flow must stay inside the repo.
 */
test("backup paths stay inside the repo when invoked from a subdirectory", async () => {
  const f = fixture();
  try {
    // git returns canonical paths (realpath, expanded 8.3 short names on
    // Windows, normalized separators) while Node's tmpdir path is lexical
    // (/tmp -> /private/tmp on macOS, RUNNER~1 -> runneradmin on Windows).
    // Compare canonical forms so the assertion tests the directory, not
    // the spelling of the temp path. The backup dir may not exist yet at
    // the list step, so canonicalize what exists and compare the rest
    // lexically — both sides derive from the same base, so equality still
    // holds.
    const canon = (p) => {
      try {
        return realpathSync(p).replace(/\\/g, "/");
      } catch {
        return p.replace(/\\/g, "/");
      }
    };

    const sub = join(f.work, "src");
    mkdirSync(sub, { recursive: true });

    const meta = repoMeta(sub);
    assert.equal(canon(meta.root), canon(f.work));
    assert.equal(
      canon(meta.gitDir),
      canon(join(f.work, ".git")),
      "git dir must resolve against the caller cwd"
    );

    const cfg = defaults();
    // listBackupFiles resolves the dir from the subdir too.
    const doc = listBackupFiles(sub, cfg);
    assert.equal(canon(doc.dir), canon(join(f.work, ".git", "git-cleanup-backups")));

    // End to end: force-prune from the subdir writes the bundle in the
    // repo's own backup dir (old code wrote it one level up).
    cfg.rules = [{ match: "wip/*", mode: "any", minAgeDays: 10 }];
    cfg.warnUnmergedAfterDays = 999;
    const repo = await analyzeRepo(sub, cfg);
    const summary = await pruneRepo(repo, cfg, { yes: true });
    assert.ok(summary.deletedLocal.includes("wip/stale"), String(summary.deletedLocal));
    const bk = summary.backups[0];
    assert.equal(
      canon(dirname(bk.file)),
      canon(join(f.work, ".git", "git-cleanup-backups")),
      bk.file
    );
    assert.ok(existsSync(bk.file), "bundle written");
  } finally {
    f.cleanup();
    repos.pop();
  }
});
