// Shared helpers: build throwaway git repos for integration tests.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DAY = 24 * 60 * 60 * 1000;

export function sh(cwd, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function identEnv(date) {
  const env = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  if (date) {
    const iso = new Date(date).toISOString();
    env.GIT_AUTHOR_DATE = iso;
    env.GIT_COMMITTER_DATE = iso;
  }
  return env;
}

/** Commit staged content on `branch`; `date` is a Date or now. */
export function commit(cwd, branch, files, { date = Date.now(), msg } = {}) {
  sh(cwd, ["checkout", "-q", "-B", branch]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(cwd, name), content);
  }
  sh(cwd, ["add", "-A"]);
  sh(cwd, ["commit", "-q", "-m", msg ?? `commit on ${branch}`], {
    env: identEnv(date),
  });
}

/** Merge `branch` into `current` with a real merge commit (no fast-forward). */
export function merge(cwd, current, branch, { date = Date.now() } = {}) {
  sh(cwd, ["checkout", "-q", current]);
  sh(cwd, ["merge", "-q", "--no-ff", branch, "-m", `merge ${branch}`], {
    env: identEnv(date),
  });
}

/**
 * Build a repo where one branch was squash-merged into the default branch
 * (its content committed on main WITHOUT merging history) and one branch is
 * genuinely divergent. Returns { base, work, cleanup }.
 */
export function makeSquashRepo() {
  const base = mkdtempSync(join(tmpdir(), "git-cleanup-test-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  sh(null, ["init", "-q", "-b", "main", "--bare", bare]);
  sh(null, ["clone", "-q", bare, work]);
  sh(work, ["config", "user.name", "Test"]);
  sh(work, ["config", "user.email", "test@example.com"]);

  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { msg: "initial" });

  // Feature work that later lands on main as a squash commit (new SHA, same tree).
  commit(work, "feature/squash", { "sq.txt": "squashed" }, {
    date: now - 40 * DAY,
    msg: "feature work (later squashed)",
  });
  sh(work, ["checkout", "-q", "main"]);
  writeFileSync(join(work, "sq.txt"), "squashed");
  sh(work, ["add", "-A"]);
  sh(work, ["commit", "-q", "-m", "Squash feature/squash (#1)"], {
    env: identEnv(now - 35 * DAY),
  });

  // Genuinely abandoned, never integrated work (must NOT be flagged merged).
  commit(work, "feature/divergent", { "other.txt": "unique" }, {
    date: now - 100 * DAY,
    msg: "abandoned divergent work",
  });

  // Net-empty branch: a no-op commit whose tree equals main's current tree.
  // Its tree matches a base tree, but its "work" was never integrated, so the
  // content guard (merge-base tree must differ) must NOT flag it as merged.
  sh(work, ["checkout", "-q", "-B", "feature/noop", "main"]);
  sh(work, ["commit", "-q", "--allow-empty", "-m", "noop"], {
    env: identEnv(now - 80 * DAY),
  });

  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["push", "-q", "origin", "feature/squash"]);
  sh(work, ["push", "-q", "origin", "feature/divergent"]);
  sh(work, ["push", "-q", "origin", "feature/noop"]);
  sh(work, ["remote", "set-head", "origin", "-a"]);

  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function baseWorkRepo(defaultBranch = "main") {
  const base = mkdtempSync(join(tmpdir(), "git-cleanup-test-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  sh(null, ["init", "-q", "-b", defaultBranch, "--bare", bare]);
  sh(null, ["clone", "-q", bare, work]);
  sh(work, ["config", "user.name", "Test"]);
  sh(work, ["config", "user.email", "test@example.com"]);
  return { base, bare, work };
}

/**
 * Golden scenario: a rebase merge.
 *
 * main@A; feature/work commits W on top of A; main advances with B;
 * feature/work is REBASED onto main (commits rewritten: new SHAs, tree A+B+W)
 * and merged back with --no-ff. The pre-rebase tip is preserved on
 * feature/work-pre-rebase (tree A+W).
 *
 * Expected (the golden data):
 *   feature/work              DELETE — tip is an ancestor of the merge
 *   feature/work-pre-rebase   WARN   — unmerged; its tree (A+W) appears
 *                            nowhere in main's history (the rebase changed
 *                            the base), so the conservative content guard
 *                            correctly refuses to call it merged
 *   main                      KEEP (head)
 */
export function makeRebaseRepo() {
  const { base, bare, work } = baseWorkRepo();
  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { msg: "initial" });

  // Branch work on top of A, 90d ago.
  commit(work, "feature/work", { "work.txt": "1" }, { date: now - 90 * DAY, msg: "feature work" });
  // Preserve the pre-rebase tip under its own ref.
  sh(work, ["branch", "feature/work-pre-rebase"]);

  // Main advances while the branch is out (60d ago). commit() uses
  // `checkout -B`, which would reset main to the CURRENT head (the feature
  // tip) — check out main first so the fixture really diverges.
  sh(work, ["checkout", "-q", "main"]);
  commit(work, "main", { "base.txt": "2" }, { date: now - 60 * DAY, msg: "main progress" });

  // Rebase the branch onto the new main (commits rewritten, 50d ago).
  sh(work, ["checkout", "-q", "feature/work"]);
  sh(work, ["rebase", "-q", "main"], { env: identEnv(now - 50 * DAY) });
  // Merge the rebased branch back in with a real merge commit (40d ago).
  merge(work, "main", "feature/work", { date: now - 40 * DAY });

  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["remote", "set-head", "origin", "-a"]);
  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Golden scenario: a cherry-pick merge (the squash-merge fingerprint).
 *
 * main@A; feature/cherry commits X1, X2; both commits are cherry-picked
 * onto main — the branch's tip TREE (A+X1+X2) now exists in main's history
 * even though no commit SHA does.
 *
 * Expected: feature/cherry DELETE (reason squash-merged), main KEEP.
 */
export function makeCherryPickRepo() {
  const { base, bare, work } = baseWorkRepo();
  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { msg: "initial" });
  commit(work, "feature/cherry", { "c1.txt": "1", "c2.txt": "2" }, { date: now - 60 * DAY, msg: "cherry work" });
  const tip = sh(work, ["rev-parse", "feature/cherry"]).out;
  sh(work, ["checkout", "-q", "main"]);
  // Note: no `-q` — modern git removed cherry-pick's -q short flag and
  // rejects it with a usage error (verified on git 2.55).
  sh(work, ["cherry-pick", tip], { env: identEnv(now - 55 * DAY) });
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["remote", "set-head", "origin", "-a"]);
  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Golden scenario: an octopus merge (one merge commit, many heads).
 *
 * main@A; f1 and f2 diverge (different files); `git merge f1 f2` creates an
 * octopus merge commit whose parents include both branch tips — so both
 * tips ARE ancestors of the base and plain ancestor detection must catch
 * them (no content guard involved).
 *
 * Expected: feature/o1 DELETE, feature/o2 DELETE, main KEEP.
 */
export function makeOctopusRepo() {
  const { base, bare, work } = baseWorkRepo();
  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { msg: "initial" });
  commit(work, "feature/o1", { "o1.txt": "1" }, { date: now - 60 * DAY, msg: "octo one" });
  commit(work, "feature/o2", { "o2.txt": "1" }, { date: now - 60 * DAY, msg: "octo two" });
  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["merge", "-q", "--no-ff", "feature/o1", "feature/o2", "-m", "octopus merge"], {
    env: identEnv(now - 50 * DAY),
  });
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["remote", "set-head", "origin", "-a"]);
  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Golden scenario: a fast-forward merge.
 *
 * main@A; feature/ff commits X on top; main fast-forwards to X — the
 * branch tip and the base tip are the SAME commit, so ancestor detection
 * must catch it.
 *
 * Expected: feature/ff DELETE, main KEEP.
 */
export function makeFfMergeRepo() {
  const { base, bare, work } = baseWorkRepo();
  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { msg: "initial" });
  commit(work, "feature/ff", { "ff.txt": "1" }, { date: now - 60 * DAY, msg: "ff work" });
  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["merge", "-q", "-m", "ff merge", "feature/ff"], { env: identEnv(now - 55 * DAY) });
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["remote", "set-head", "origin", "-a"]);
  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Golden scenario: hundreds of branches.
 *
 * main@A, then `n` feature branches each merged back with --no-ff (60d/50d
 * ago) and `stale` unmerged branches (100d ago, never pushed).
 *
 * Expected: exactly n DELETE (reason merged) · stale WARN · main KEEP — the
 * counts prove no phantom verdicts appear at scale.
 */
export function makeManyBranchesRepo(n = 200, stale = 30) {
  const { base, bare, work } = baseWorkRepo();
  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { msg: "initial" });
  for (let i = 0; i < n; i++) {
    commit(work, `merged/branch-${i}`, { [`f${i}.txt`]: "1" }, { date: now - 60 * DAY, msg: `work ${i}` });
    merge(work, "main", `merged/branch-${i}`, { date: now - 50 * DAY });
  }
  for (let i = 0; i < stale; i++) {
    commit(work, `stale/branch-${i}`, { [`s${i}.txt`]: "1" }, { date: now - 100 * DAY, msg: `stale ${i}` });
  }
  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["remote", "set-head", "origin", "-a"]);
  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Build a work repo with a bare origin and a rich set of branches:
 *
 * local (HEAD on main):
 *   main                     merged base, checked out        -> keep (head)
 *   feature/merged-old       merged 60d ago, never pushed    -> DELETE (orphan+merged)
 *   feature/merged-old2      merged 50d ago + pushed         -> DELETE local & remote
 *   release/v1               merged 40d ago + pushed         -> keep (protected)
 *   wip/stale                unmerged 100d ago + pushed      -> warn (stale)
 *   keep-local               fresh, never pushed             -> keep (active)
 *
 * remote (origin/*):
 *   main, release/v1 (protected), feature/merged-old2 (DELETE), wip/stale (warn)
 *
 * Returns { base, work, cleanup }.
 */
export function makeWorkRepo(defaultBranch = "main") {
  const { base, bare, work } = baseWorkRepo(defaultBranch);

  const now = Date.now();
  commit(work, defaultBranch, { "README.md": "root" }, { msg: "initial" });

  commit(work, "feature/merged-old", { "old.txt": "1" }, { date: now - 60 * DAY, msg: "old work" });
  merge(work, defaultBranch, "feature/merged-old", { date: now - 1 * DAY });

  commit(work, "feature/merged-old2", { "old2.txt": "1" }, { date: now - 50 * DAY, msg: "old work 2" });
  merge(work, defaultBranch, "feature/merged-old2", { date: now - 2 * DAY });

  commit(work, "release/v1", { "rel.txt": "1" }, { date: now - 40 * DAY, msg: "release prep" });
  merge(work, defaultBranch, "release/v1", { date: now - 3 * DAY });

  commit(work, "wip/stale", { "stale.txt": "1" }, { date: now - 100 * DAY, msg: "abandoned wip" });
  commit(work, "keep-local", { "fresh.txt": "1" }, { date: now, msg: "fresh work" });

  // Publish: the default branch (with merges) and the pushed branches.
  sh(work, ["checkout", "-q", defaultBranch]);
  sh(work, ["push", "-q", "origin", defaultBranch]);
  sh(work, ["push", "-q", "origin", "feature/merged-old2"]);
  sh(work, ["push", "-q", "origin", "release/v1"]);
  sh(work, ["push", "-q", "origin", "wip/stale"]);

  // Real clones carry refs/remotes/origin/HEAD; make the fixtures match so
  // the symbolic-HEAD ref is exercised (regression: it used to surface as a
  // phantom remote branch named after the remote).
  sh(work, ["remote", "set-head", "origin", "-a"]);

  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
