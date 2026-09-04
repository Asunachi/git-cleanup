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

  sh(work, ["checkout", "-q", "main"]);
  sh(work, ["push", "-q", "origin", "main"]);
  sh(work, ["push", "-q", "origin", "feature/squash"]);
  sh(work, ["push", "-q", "origin", "feature/divergent"]);

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
  const base = mkdtempSync(join(tmpdir(), "git-cleanup-test-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  sh(null, ["init", "-q", "-b", defaultBranch, "--bare", bare]);
  sh(null, ["clone", "-q", bare, work]);
  sh(work, ["config", "user.name", "Test"]);
  sh(work, ["config", "user.email", "test@example.com"]);

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

  return {
    base,
    bare,
    work,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
