import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DAY, commit, makeSquashRepo, makeWorkRepo, merge, sh } from "./helpers.mjs";
import { analyzeRepo } from "../src/analyze.mjs";
import { pruneRepo } from "../src/prune.mjs";
import { defaults, VERDICTS } from "../src/classify.mjs";
import { listBranches } from "../src/git.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "git-cleanup.mjs");

const repos = [];
function fixture(defaultBranch) {
  const f = makeWorkRepo(defaultBranch);
  repos.push(f);
  return f;
}
function fixture2() {
  const f = makeSquashRepo();
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

test("analyzeRepo classifies every branch correctly", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);

    assert.equal(repo.notGit, false);
    assert.deepEqual(repo.baseRefs, ["origin/main"]);
    assert.equal(repo.pr.source, "none"); // local bare remote: no GitHub

    const expectDelete = new Set(["feature/merged-old", "feature/merged-old2"]);
    const expectWarn = new Set(["wip/stale"]);
    const expectKeep = new Set(["main", "release/v1", "keep-local"]);
    const local = repo.branches.filter((b) => b.type === "local");
    for (const b of local) {
      const verdict =
        b.verdict === VERDICTS.DELETE
          ? "delete"
          : b.verdict === VERDICTS.WARN
            ? "warn"
            : "keep";
      const want = expectDelete.has(b.name)
        ? "delete"
        : expectWarn.has(b.name)
          ? "warn"
          : "keep";
      assert.equal(verdict, want, `local ${b.name}`);
      if (b.name === "feature/merged-old") {
        assert.equal(b.orphan, true); // never pushed, upstream gone
        assert.equal(b.merged, true);
        assert.ok(b.ageDays >= 55, `age ${b.ageDays}`);
      }
      if (b.name === "wip/stale") {
        assert.equal(b.merged, false);
        assert.ok(b.ageDays >= 95);
      }
      if (b.name === "main") assert.equal(b.reason, "head");
      if (b.name === "release/v1") assert.equal(b.reason, "protected");
      if (b.name === "keep-local") assert.equal(b.reason, "active");
    }

    // Remote side
    const remote = repo.branches.filter((b) => b.type === "remote");
    const remoteNames = remote.map((b) => b.name);
    assert.deepEqual(
      remoteNames.sort(),
      ["origin/feature/merged-old2", "origin/main", "origin/release/v1", "origin/wip/stale"].sort()
    );
    assert.equal(byName(repo, "origin/feature/merged-old2").verdict, VERDICTS.DELETE);
    assert.equal(byName(repo, "origin/main").verdict, VERDICTS.KEEP);
    assert.equal(byName(repo, "origin/release/v1").verdict, VERDICTS.KEEP);
    assert.equal(byName(repo, "origin/wip/stale").verdict, VERDICTS.WARN);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("pruneRepo refuses to run non-interactively without --yes", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);
    await assert.rejects(
      () => pruneRepo(repo, cfg, {}),
      /--yes/
    );
    // nothing deleted
    const names = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(names.includes("feature/merged-old"));
    assert.ok(names.includes("feature/merged-old2"));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("pruneRepo deletes merged local and remote branches", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);
    const summary = await pruneRepo(repo, cfg, { yes: true, remote: true });

    assert.deepEqual(summary.deletedLocal.sort(), ["feature/merged-old", "feature/merged-old2"]);
    assert.deepEqual(summary.deletedRemote, ["origin/feature/merged-old2"]);
    assert.deepEqual(summary.errors, []);

    const localNames = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(!localNames.includes("feature/merged-old"));
    assert.ok(!localNames.includes("feature/merged-old2"));
    assert.ok(localNames.includes("main"));
    assert.ok(localNames.includes("release/v1")); // protected survived
    assert.ok(localNames.includes("keep-local"));
    assert.ok(localNames.includes("wip/stale")); // unmerged survived

    const remoteHeads = sh(f.work, ["ls-remote", "--heads", "origin"]).out.split("\n");
    assert.ok(!remoteHeads.some((l) => l.includes("refs/heads/feature/merged-old2")));
    assert.ok(remoteHeads.some((l) => l.includes("refs/heads/release/v1")));
    assert.ok(remoteHeads.some((l) => l.includes("refs/heads/wip/stale")));

    // second run: nothing left to prune
    const repo2 = await analyzeRepo(f.work, cfg);
    const summary2 = await pruneRepo(repo2, cfg, { yes: true, remote: true });
    assert.equal(summary2.nothing, true);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("force rules prune unmerged scratch branches", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    cfg.rules = [{ match: "wip/*", mode: "any", minAgeDays: 10 }];
    cfg.warnUnmergedAfterDays = 999; // keep the noise down
    const repo = await analyzeRepo(f.work, cfg);
    const summary = await pruneRepo(repo, cfg, { yes: true });
    assert.ok(summary.deletedLocal.includes("wip/stale"), String(summary.deletedLocal));
    const localNames = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(!localNames.includes("wip/stale"));
    assert.ok(localNames.includes("keep-local"));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("force-deleted branches are bundled first and restorable", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    cfg.rules = [{ match: "wip/*", mode: "any", minAgeDays: 10 }];
    cfg.warnUnmergedAfterDays = 999;
    const repo = await analyzeRepo(f.work, cfg);
    const summary = await pruneRepo(repo, cfg, { yes: true });
    // wip/stale force-deleted (-D), merged branches deleted with -d
    assert.ok(summary.deletedLocal.includes("wip/stale"), String(summary.deletedLocal));
    assert.ok(summary.deletedLocal.includes("feature/merged-old"));
    // Only the -D deletion is backed up; -d keeps commits reachable from the base.
    assert.equal(summary.backups.length, 1, String(summary.backups));
    const bk = summary.backups[0];
    assert.ok(bk.file.endsWith("-force.bundle"), bk.file);
    assert.deepEqual(bk.branches, ["wip/stale"]);
    assert.ok(existsSync(bk.file), bk.file);
    sh(f.work, ["bundle", "verify", bk.file]); // throws on a broken bundle

    // The deleted work is gone from the repo but recoverable from the bundle.
    const localNames = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(!localNames.includes("wip/stale"));
    sh(f.work, ["fetch", bk.file, "+refs/heads/*:refs/heads/*"]);
    const restored = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(restored.includes("wip/stale"));
    const blob = sh(f.work, ["cat-file", "-e", "wip/stale:stale.txt"]).ok;
    assert.ok(blob, "stale.txt should be reachable from the restored branch");
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("backups can be disabled via config", async () => {
  const f = fixture();
  try {
    const cfg = defaults();
    cfg.rules = [{ match: "wip/*", mode: "any", minAgeDays: 10 }];
    cfg.backup = { enabled: false };
    const repo = await analyzeRepo(f.work, cfg);
    const summary = await pruneRepo(repo, cfg, { yes: true });
    assert.ok(summary.deletedLocal.includes("wip/stale"));
    assert.equal(summary.backups.length, 0);
    assert.ok(!existsSync(join(f.work, ".git", "git-cleanup-backups")));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("backup retention sweeps old bundles during prune, keeps fresh ones", async () => {
  const f = fixture();
  try {
    const mkCfg = (retainDays) => {
      const cfg = defaults();
      cfg.rules = [{ match: "wip/*", mode: "any", minAgeDays: 10 }];
      cfg.warnUnmergedAfterDays = 999;
      if (retainDays !== null) cfg.backup = { retainDays };
      return cfg;
    };
    // First prune creates a force bundle for wip/stale.
    const s1 = await pruneRepo(await analyzeRepo(f.work, mkCfg(null)), mkCfg(null), { yes: true });
    assert.equal(s1.backups.length, 1, String(s1.backups));
    const oldBundle = s1.backups[0].file;
    assert.ok(existsSync(oldBundle));

    // Backdate it past the window and add a fresh copy that must survive.
    // (On Windows, copyFileSync preserves the source's timestamps, so the
    // fresh copy's mtime must be set explicitly — otherwise the retention
    // sweep would rightly treat it as old.)
    const past = new Date(Date.now() - 30 * DAY);
    utimesSync(oldBundle, past, past);
    const freshBundle = oldBundle.replace(/-force\.bundle$/, "-force-copy.bundle");
    copyFileSync(oldBundle, freshBundle);
    utimesSync(freshBundle, new Date(), new Date());

    // Second prune: wip/stale is gone (only a remote candidate is listed, not
    // deleted without --remote) — retention still sweeps.
    const s2 = await pruneRepo(await analyzeRepo(f.work, mkCfg(7)), mkCfg(7), { yes: true });
    assert.ok(s2.deletedBackups.includes(oldBundle), String(s2.deletedBackups));
    assert.ok(!existsSync(oldBundle), "old bundle should be removed");
    assert.ok(existsSync(freshBundle), "fresh bundle should be kept");

    // retainDays 0 (the default) keeps everything, even old bundles.
    utimesSync(freshBundle, past, past);
    const s3 = await pruneRepo(await analyzeRepo(f.work, mkCfg(null)), mkCfg(null), { yes: true });
    assert.deepEqual(s3.deletedBackups, []);
    assert.ok(existsSync(freshBundle));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("CLI: scan --json and --check exit code", () => {
  const f = fixture();
  try {
    const home = mkdtempSync(join(tmpdir(), "gc-home-"));
    const env = { ...process.env, HOME: home, GIT_CLEANUP_NO_COLOR: "1" };
    const runCli = (args) =>
      spawnSync(process.execPath, [BIN, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env,
      });

    const json = runCli(["scan", "--json", "--repo", f.work]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.repos.length, 1);
    const r = parsed.repos[0];
    const del = r.branches.filter((b) => b.verdict === "delete");
    assert.deepEqual(
      del.map((b) => b.name).sort(),
      ["feature/merged-old", "feature/merged-old2", "origin/feature/merged-old2"].sort()
    );

    const check = runCli(["scan", "--check", "--repo", f.work]);
    assert.equal(check.status, 2, `expected exit 2, got ${check.status}\n${check.stdout}`);

    const warn = runCli(["prs", "--json", "--repo", f.work]);
    assert.equal(warn.status, 0);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("squash-merged branches are detected by content and pruned safely", async () => {
  const f = fixture2();
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);

    const squash = byName(repo, "feature/squash");
    assert.equal(squash.merged, false); // not an ancestor merge
    assert.equal(squash.contentMerged, true);
    assert.equal(squash.verdict, VERDICTS.DELETE);
    assert.equal(squash.reason, "squash-merged");

    const remoteSquash = byName(repo, "origin/feature/squash");
    assert.equal(remoteSquash.contentMerged, true);
    assert.equal(remoteSquash.verdict, VERDICTS.DELETE);
    assert.equal(remoteSquash.reason, "squash-merged");

    // Genuinely divergent work must NOT be flagged as merged.
    const divergent = byName(repo, "feature/divergent");
    assert.equal(divergent.contentMerged, false);
    assert.notEqual(divergent.verdict, VERDICTS.DELETE);

    // Net-empty branch (tree equals main's tree, but never integrated) must
    // NOT be flagged either: the merge-base guard excludes it.
    const noop = byName(repo, "feature/noop");
    assert.equal(noop.contentMerged, false);
    assert.notEqual(noop.verdict, VERDICTS.DELETE);

    const remoteNoop = byName(repo, "origin/feature/noop");
    assert.equal(remoteNoop.contentMerged, false);
    assert.notEqual(remoteNoop.verdict, VERDICTS.DELETE);

    const summary = await pruneRepo(repo, cfg, { yes: true, remote: true });
    assert.ok(summary.deletedLocal.includes("feature/squash"));
    assert.deepEqual(summary.deletedRemote, ["origin/feature/squash"]);
    assert.equal(summary.errors.length, 0);
    // -D local and push-delete remote branches were bundled before deletion.
    const bkLocal = summary.backups.find((b) => b.file.endsWith("-squash.bundle"));
    const bkRemote = summary.backups.find((b) => b.file.endsWith("-remote.bundle"));
    assert.ok(bkLocal, String(summary.backups.map((b) => b.file)));
    assert.ok(bkRemote, String(summary.backups.map((b) => b.file)));
    assert.ok(
      sh(f.work, ["bundle", "list-heads", bkLocal.file]).out.includes("refs/heads/feature/squash")
    );
    assert.ok(
      sh(f.work, ["bundle", "list-heads", bkRemote.file]).out.includes(
        "refs/remotes/origin/feature/squash"
      )
    );

    const localNames = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(!localNames.includes("feature/squash"));
    assert.ok(localNames.includes("feature/divergent"));
    assert.ok(localNames.includes("feature/noop"));
    assert.ok(localNames.includes("main"));

    const remoteHeads = sh(f.work, ["ls-remote", "--heads", "origin"]).out;
    assert.ok(!remoteHeads.includes("refs/heads/feature/squash"));
    assert.ok(remoteHeads.includes("refs/heads/feature/divergent"));
    assert.ok(remoteHeads.includes("refs/heads/feature/noop"));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("merge detection works when the default branch is not main/master", async () => {
  // Regression: origin/HEAD must be read via the remote's symref; a literal
  // ref name lookup used to make every non-main/master default invisible,
  // so merged branches were never recognized.
  const f = fixture("trunk");
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(f.work, cfg);
    assert.deepEqual(repo.baseRefs, ["origin/trunk"]);
    const old = byName(repo, "feature/merged-old");
    assert.equal(old.merged, true, "tip should be an ancestor of origin/trunk");
    assert.equal(old.verdict, VERDICTS.DELETE);

    const summary = await pruneRepo(repo, cfg, { yes: true, remote: true });
    assert.ok(summary.deletedLocal.includes("feature/merged-old"));
    assert.ok(summary.deletedLocal.includes("feature/merged-old2"));
    assert.deepEqual(summary.deletedRemote, ["origin/feature/merged-old2"]);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("CLI: prune --yes --remote cleans everything", () => {
  const f = fixture();
  try {
    const home = mkdtempSync(join(tmpdir(), "gc-home-"));
    const env = { ...process.env, HOME: home, GIT_CLEANUP_NO_COLOR: "1" };
    const r = spawnSync(
      process.execPath,
      [BIN, "prune", "--yes", "--remote", "--repo", f.work],
      { cwd: ROOT, encoding: "utf8", env }
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /deleted 2 local/);
    assert.match(r.stdout, /deleted 1 remote/);

    const names = listBranches(f.work, "heads").map((b) => b.name);
    assert.ok(!names.includes("feature/merged-old"));
    assert.ok(names.includes("release/v1"));
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("CLI: --repo pointing at a file errors cleanly (no ENOTDIR crash)", () => {
  const f = fixture();
  try {
    const home = mkdtempSync(join(tmpdir(), "gc-home-"));
    const env = { ...process.env, HOME: home, GIT_CLEANUP_NO_COLOR: "1" };
    const runCli = (args) =>
      spawnSync(process.execPath, [BIN, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env,
      });
    const file = join(f.work, "not-a-repo.txt");
    writeFileSync(file, "x");

    const r = runCli(["scan", "--repo", file]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /is not a directory/);

    // JSON mode must still emit one valid document with the error inside.
    const j = runCli(["scan", "--json", "--repo", file]);
    assert.equal(j.status, 1, j.stdout + j.stderr);
    const doc = JSON.parse(j.stdout);
    assert.equal(doc.repos[0].notGit, true);
    assert.match(doc.repos[0].error, /is not a directory/);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

test("CLI: prs --json always emits one parseable JSON document", () => {
  const f = fixture();
  try {
    const home = mkdtempSync(join(tmpdir(), "gc-home-"));
    const env = { ...process.env, HOME: home, GIT_CLEANUP_NO_COLOR: "1" };
    const runCli = (args) =>
      spawnSync(process.execPath, [BIN, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env,
      });
    // The fixture's origin is a local path, not a forge host: no PR backend,
    // so the contract is an empty array — still valid, parseable JSON (an
    // empty stdout would not be).
    const r = runCli(["prs", "--json", "--repo", f.work]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);

    // Even when every repo is unreadable the output is still one parseable
    // document carrying the errors (exit 1), not empty stdout.
    const bad = runCli(["prs", "--json", "--repo", join(f.work, "missing")]);
    assert.equal(bad.status, 1);
    const doc = JSON.parse(bad.stdout);
    assert.equal(doc.length, 1);
    assert.match(doc[0].error, /does not exist/);
  } finally {
    f.cleanup();
    repos.pop();
  }
});

/**
 * Build a repo where `name` was merged into origin/<default> but the local
 * <default> was reset behind the merge, so plain `-d` refuses. The branch is
 * never pushed, so it has no upstream for -d to fall back on.
 */
function remoteMergedStaleHeadRepo(name) {
  const base = mkdtempSync(join(tmpdir(), "git-cleanup-test-"));
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  sh(null, ["init", "-q", "-b", "main", "--bare", bare]);
  sh(null, ["clone", "-q", bare, work]);
  sh(work, ["config", "user.name", "Test"]);
  sh(work, ["config", "user.email", "test@example.com"]);
  const now = Date.now();
  commit(work, "main", { "README.md": "root" }, { msg: "initial" });
  commit(work, name, { "old.txt": "1" }, { date: now - 60 * DAY, msg: "old work" });
  merge(work, "main", name, { date: now - 30 * DAY });
  sh(work, ["push", "-q", "origin", "main"]); // origin/main contains `name`
  sh(work, ["reset", "-q", "--hard", "HEAD~1"]); // local HEAD now behind the merge
  sh(work, ["remote", "set-head", "origin", "-a"]);
  return { base, bare, work };
}

test("-d refusal falls back to -D with a backup (merged into remote base, not local HEAD)", async () => {
  const r = remoteMergedStaleHeadRepo("feature/old");
  try {
    const cfg = defaults();
    const repo = await analyzeRepo(r.work, cfg);
    const old = byName(repo, "feature/old");
    assert.equal(old.merged, true);
    assert.equal(old.verdict, VERDICTS.DELETE);

    const summary = await pruneRepo(repo, cfg, { yes: true });
    assert.equal(summary.errors.length, 0, JSON.stringify(summary.errors));
    assert.ok(summary.deletedLocal.includes("feature/old"));

    // The forced deletion was backed up first: a -force bundle with the ref.
    const bk = summary.backups.find((b) => b.file.endsWith("-force.bundle"));
    assert.ok(bk, String(summary.backups.map((b) => b.file)));
    assert.ok(
      sh(r.work, ["bundle", "list-heads", bk.file]).out.includes("refs/heads/feature/old")
    );

    // The remote base is untouched and the local branch is gone.
    const remoteHeads = sh(r.work, ["ls-remote", "--heads", "origin"]).out;
    assert.ok(remoteHeads.includes("refs/heads/main"));
    const names = listBranches(r.work, "heads").map((b) => b.name);
    assert.ok(!names.includes("feature/old"));
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("-d fallback does not mask real refusals (branch checked out in a worktree)", async () => {
  const r = remoteMergedStaleHeadRepo("feature/wt");
  try {
    // Check the branch out in a linked worktree: -d and -D both refuse.
    const wtDir = join(r.base, "wt");
    sh(r.work, ["worktree", "add", "-q", wtDir, "feature/wt"]);

    const cfg = defaults();
    const repo = await analyzeRepo(r.work, cfg);
    const wt = byName(repo, "feature/wt");
    assert.equal(wt.merged, true);
    assert.equal(wt.verdict, VERDICTS.DELETE);

    const summary = await pruneRepo(repo, cfg, { yes: true });
    // Not silently deleted: the failure surfaces as an error and the branch
    // (still checked out in the worktree) survives. Accept both git phrasings
    // — "used by worktree at" and the older "checked out at" — since the
    // exact wording drifts across git versions on different CI OS runners.
    assert.equal(summary.errors.length, 1, JSON.stringify(summary.errors));
    assert.match(summary.errors[0].error, /used by worktree|checked out at/);
    assert.ok(!summary.deletedLocal.includes("feature/wt"));
    const names = listBranches(r.work, "heads").map((b) => b.name);
    assert.ok(names.includes("feature/wt"));
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("-d fallback keeps real refusals visible with a spaced worktree path (Windows/macOS)", async () => {
  // The path is passed as a single argv element, never through a shell, so a
  // directory containing spaces exercises the OS differences where quoting
  // usually breaks: on Windows the error message carries a backslash path,
  // on macOS/Linux a forward-slash one — normalize before asserting.
  const r = remoteMergedStaleHeadRepo("feature/wt-spaced");
  try {
    const wtDir = join(r.base, "worktree with spaces");
    sh(r.work, ["worktree", "add", "-q", wtDir, "feature/wt-spaced"]);

    const cfg = defaults();
    const repo = await analyzeRepo(r.work, cfg);
    const wt = byName(repo, "feature/wt-spaced");
    assert.equal(wt.merged, true);
    assert.equal(wt.verdict, VERDICTS.DELETE);

    const summary = await pruneRepo(repo, cfg, { yes: true });
    assert.equal(summary.errors.length, 1, JSON.stringify(summary.errors));
    assert.match(summary.errors[0].error, /used by worktree|checked out at/);
    // The refusal must name the exact worktree path, backslashes normalized
    // so the same assertion holds on Windows and POSIX.
    const errPath = summary.errors[0].error.replace(/\\/g, "/");
    assert.ok(errPath.includes(wtDir.replace(/\\/g, "/")), summary.errors[0].error);
    assert.ok(!summary.deletedLocal.includes("feature/wt-spaced"));
    const names = listBranches(r.work, "heads").map((b) => b.name);
    assert.ok(names.includes("feature/wt-spaced"));
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("remote branch already deleted on the server: prune the stale tracking ref instead of erroring", () => {
  const f = fixture();
  try {
    // The server no longer has feature/merged-old2 (deleted in the web UI or
    // by another machine) — only our stale local tracking ref remains.
    sh(f.bare, ["update-ref", "-d", "refs/heads/feature/merged-old2"]);

    const home = mkdtempSync(join(tmpdir(), "gc-home-"));
    const env = { ...process.env, HOME: home, GIT_CLEANUP_NO_COLOR: "1" };
    const r = spawnSync(
      process.execPath,
      [BIN, "prune", "--yes", "--remote", "--repo", f.work],
      { cwd: ROOT, encoding: "utf8", env }
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The local merged branch was deleted normally; the remote branch was
    // not pushed (already gone) but its stale tracking ref was pruned.
    assert.match(r.stdout, /deleted 2 local branches/);
    assert.match(r.stdout, /already gone on the server/);
    assert.match(r.stdout, /pruned 1 stale remote ref/);

    const remoteNames = listBranches(f.work, "remotes").map((b) => b.name);
    assert.ok(!remoteNames.includes("origin/feature/merged-old2"));
    // Still absent on the server, and the server's other refs are untouched.
    const serverHeads = sh(f.bare, [
      "for-each-ref",
      "refs/heads",
      "--format=%(refname:short)",
    ]).out;
    assert.ok(!serverHeads.includes("feature/merged-old2"));
    assert.ok(serverHeads.includes("main"));
    assert.ok(serverHeads.includes("release/v1"));
    assert.ok(serverHeads.includes("wip/stale"));
  } finally {
    f.cleanup();
    repos.pop();
  }
});
