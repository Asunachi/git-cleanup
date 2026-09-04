import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeWorkRepo, sh } from "./helpers.mjs";
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
