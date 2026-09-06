// Tests for the `sweep` CLI command (src/sweep.mjs): one pass over every
// configured repo — scan, prune by policy (mode "report" never deletes,
// "prune" goes through the same confirmed() gate as `prune`), one markdown
// report, one JSON document, optional forge-issue post.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSquashRepo, makeWorkRepo } from "../support/helpers.mjs";
import { runSweep, renderSweepMarkdown } from "../src/sweep.mjs";
import { defaults, VERDICTS } from "../src/classify.mjs";
import { listBranches } from "../src/git.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run the CLI as a child process (piped stdio => non-interactive). */
function runCli(args, env, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "bin", "git-cleanup.mjs"), ...args], {
      cwd,
      env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
}

/** A tiny git repo with one remote; returns its path. */
function makeRepo(t, remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "gc-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", remoteUrl);
  return dir;
}

function writeConfig(t, obj) {
  const dir = mkdtempSync(join(tmpdir(), "gc-sweep-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

const branchNames = (repoPath) =>
  listBranches(repoPath, "heads").map((b) => b.name);

test("sweep default mode is report: scans, deletes nothing, exits 0", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const cfg = writeConfig(t, { repos: [f.work] });
  const r = await runCli(["sweep", "--config", cfg, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.command, "sweep");
  assert.equal(doc.mode, "report");
  assert.equal(doc.repos.length, 1);
  const repo = doc.repos[0];
  assert.equal(repo.mode, "report");
  assert.equal(repo.prunable, 3);
  assert.equal(repo.stale, 2);
  assert.equal(repo.kept, 5);
  assert.deepEqual(repo.deletedLocal, []);
  assert.deepEqual(repo.deletedRemote, []);
  // Nothing was deleted.
  const names = branchNames(f.work);
  assert.ok(names.includes("feature/merged-old"));
  assert.ok(names.includes("feature/merged-old2"));
});

test("sweep prune mode deletes merged branches only with --yes", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const cfg = writeConfig(t, { sweep: { mode: "prune" }, repos: [f.work] });
  const r = await runCli(["sweep", "--config", cfg, "--yes", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.repos[0].mode, "prune");
  assert.deepEqual(
    doc.repos[0].deletedLocal.sort(),
    ["feature/merged-old", "feature/merged-old2"].sort()
  );
  const names = branchNames(f.work);
  assert.ok(!names.includes("feature/merged-old"));
  assert.ok(!names.includes("feature/merged-old2"));
  // Remote deletions need --remote; the remote branch survived.
  assert.deepEqual(doc.repos[0].deletedRemote, []);
});

test("sweep prune mode without --yes fails loudly non-interactively", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const cfg = writeConfig(t, { sweep: { mode: "prune" }, repos: [f.work] });
  const r = await runCli(["sweep", "--config", cfg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non-interactive session: pass --yes/);
  const names = branchNames(f.work);
  assert.ok(names.includes("feature/merged-old"), "nothing was deleted");
});

test("sweep --dry-run deletes nothing and reports would-delete", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const cfg = writeConfig(t, { sweep: { mode: "prune" }, repos: [f.work] });
  const r = await runCli(["sweep", "--config", cfg, "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.dryRun, true);
  assert.deepEqual(
    doc.repos[0].wouldDelete.sort(),
    ["feature/merged-old", "feature/merged-old2"].sort()
  );
  assert.deepEqual(doc.repos[0].deletedLocal, []);
  const names = branchNames(f.work);
  assert.ok(names.includes("feature/merged-old"));
  assert.ok(names.includes("feature/merged-old2"));
});

test("per-repo mode override: one repo prunes, the other only reports", async (t) => {
  const f1 = makeWorkRepo();
  const f2 = makeWorkRepo();
  t.after(() => {
    f1.cleanup();
    f2.cleanup();
  });
  const cfg = writeConfig(t, {
    repos: [{ path: f1.work, mode: "prune" }, { path: f2.work }],
  });
  const r = await runCli(["sweep", "--config", cfg, "--yes", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.repos[0].mode, "prune");
  assert.equal(doc.repos[0].deletedLocal.length, 2);
  assert.equal(doc.repos[1].mode, "report");
  assert.deepEqual(doc.repos[1].deletedLocal, []);
  assert.ok(branchNames(f2.work).includes("feature/merged-old"));
});

test("sweep --report writes a combined markdown report", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const cfg = writeConfig(t, { repos: [f.work] });
  const reportFile = join(tmpdir(), `gc-sweep-report-${Date.now()}.md`);
  t.after(() => rmSync(reportFile, { force: true }));
  const r = await runCli(["sweep", "--config", cfg, "--report", reportFile, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.report.file, reportFile);
  assert.equal(doc.report.written, true);
  const md = readFileSync(reportFile, "utf8");
  assert.ok(md.includes("## " + f.work + " `(report)`"));
  assert.match(md, /^# git-cleanup sweep report/m);
  assert.match(md, /prunable: 3 · stale: 2 · kept: 5/);
  assert.match(md, /feature\/merged-old/);
});

test("sweep reportIssue posts the report as an issue on the forge", async (t) => {
  const dir = makeRepo(t, "git@github.com:owner/repo.git");
  const cfg = writeConfig(t, {
    sweep: { reportIssue: { title: "git-cleanup: branch report" } },
    repos: [dir],
  });
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      res.end(JSON.stringify({ number: 3, html_url: "https://github.com/owner/repo/issues/3" }));
    } else {
      res.end(JSON.stringify([]));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    ...process.env,
    GITHUB_TOKEN: "gh-token",
    GITHUB_API_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  const r = await runCli(["sweep", "--config", cfg, "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.issue.action, "created");
  assert.equal(doc.issue.number, 3);
  assert.equal(doc.issue.url, "https://github.com/owner/repo/issues/3");
  assert.equal(doc.issue.dryRun, false);
  assert.ok(methods.includes("POST"), "the write went through");
});

test("sweep --report-issue in dry-run never writes; issue shows would-create", async (t) => {
  const dir = makeRepo(t, "git@github.com:owner/repo.git");
  const cfg = writeConfig(t, { repos: [dir] });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.method);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    ...process.env,
    GITHUB_TOKEN: "gh-token",
    GITHUB_API_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  const r = await runCli(
    ["sweep", "--config", cfg, "--report-issue", "git-cleanup: branch report", "--dry-run", "--json"],
    env
  );
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.dryRun, true);
  assert.equal(doc.issue.action, "created");
  assert.equal(doc.issue.dryRun, true);
  assert.match(doc.issue.url, /issues\/new\?title=/);
  // The read-only search ran; no write ever reached the server.
  assert.deepEqual(seen, ["GET"]);
});

test("sweep reportIssue with no forge remote fails loudly, never silent", async (t) => {
  const f = makeWorkRepo(); // bare-origin fixture: no forge remote
  t.after(() => f.cleanup());
  const cfg = writeConfig(t, { sweep: { reportIssue: true }, repos: [f.work] });
  const r = await runCli(["sweep", "--config", cfg, "--json"]);
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout);
  assert.match(doc.issue.error, /no repo with a forge remote/);
});

test("sweep surfaces unreadable repos as errors", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const missing = join(tmpdir(), "gc-sweep-missing");
  const cfg = writeConfig(t, { repos: [f.work, missing] });
  const r = await runCli(["sweep", "--config", cfg, "--json"]);
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.repos[1].notGit, true);
  assert.match(doc.repos[1].error, /does not exist/);
  assert.equal(doc.repos[0].notGit, undefined);
});

// ---- unit: rendering and the runSweep return contract -----------------------

test("renderSweepMarkdown covers every doc field", () => {
  const md = renderSweepMarkdown(
    [
      {
        path: "/repo/a",
        mode: "prune",
        notGit: false,
        prunable: 2,
        stale: 1,
        kept: 3,
        wouldDelete: ["feat/x"],
        deletedLocal: ["feat/x"],
        deletedRemote: ["origin/feat/y"],
        prunedRemote: ["origin/feat/z"],
        deletedBackups: ["/b/backup-1.bundle"],
        backups: [],
        errors: [],
      },
      { path: "/repo/b", mode: "report", notGit: true, error: "boom" },
    ],
    { dryRun: true }
  );
  assert.match(md, /dry-run \(nothing was changed\)/);
  assert.match(md, /## \/repo\/a `\(prune\)`/);
  assert.match(md, /deleted local: feat\/x/);
  assert.match(md, /deleted remote: origin\/feat\/y/);
  assert.match(md, /pruned stale remote refs: origin\/feat\/z/);
  assert.match(md, /## \/repo\/b `\(report\)`/);
  assert.match(md, /error: boom/);
});

test("runSweep JSON contract: report mode leaves issue/report null", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const cfg = defaults();
  cfg.repos = [f.work];
  const result = await runSweep({
    repoSpecs: [{ path: f.work }],
    cfg,
    opts: {},
    configDir: process.cwd(),
  });
  assert.equal(result.hadError, false);
  assert.equal(result.issue, null);
  assert.equal(result.report, null);
  assert.equal(result.json.repos[0].mode, "report");
  assert.ok(result.json.repos[0].prunable > 0);
  assert.deepEqual(result.json.repos[0].errors, []);
  const names = branchNames(f.work);
  assert.ok(names.includes("feature/merged-old"));
});

test("sweep prune keeps remote branches unless --remote / sweep.remote", async (t) => {
  const f = makeWorkRepo();
  t.after(() => f.cleanup());
  const cfg = writeConfig(t, { sweep: { mode: "prune" }, repos: [f.work] });
  const r = await runCli(["sweep", "--config", cfg, "--yes", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.repos[0].deletedRemote, []);
  // The remote branch is still tracked.
  const remotes = listBranches(f.work, "remotes").map((b) => b.name);
  assert.ok(remotes.includes("origin/feature/merged-old2"));

  // sweep.remote: true turns remote deletion on for prune-mode repos.
  const cfg2 = writeConfig(t, {
    sweep: { mode: "prune", remote: true },
    repos: [f.work],
  });
  const r2 = await runCli(["sweep", "--config", cfg2, "--yes", "--json"]);
  assert.equal(r2.status, 0, r2.stderr);
  const doc2 = JSON.parse(r2.stdout);
  assert.deepEqual(doc2.repos[0].deletedRemote, ["origin/feature/merged-old2"]);
});

test("sweep human output renders counts, would-delete, and the report path", async (t) => {
  const f = makeSquashRepoFixture(t);
  const cfg = writeConfig(t, { sweep: { mode: "prune" }, repos: [f.work] });
  const reportFile = join(tmpdir(), `gc-sweep-human-${Date.now()}.md`);
  t.after(() => rmSync(reportFile, { force: true }));
  const r = await runCli(["sweep", "--config", cfg, "--dry-run", "--report", reportFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /🌪 sweep: 1 repo · 1 scanned · mode prune · dry-run/);
  assert.match(r.stdout, /would delete: feature\/squash/);
  assert.match(r.stdout, /report: /);
  assert.match(r.stdout, /prunable/);
});

test("renderSweepMarkdown lists written backup bundles", () => {
  const md = renderSweepMarkdown([
    {
      path: "/repo/a",
      mode: "prune",
      prunable: 1,
      stale: 0,
      kept: 0,
      backups: ["/b/backup-1.bundle", "/b/backup-2.bundle"],
      deletedBackups: [],
      deletedLocal: [],
      deletedRemote: [],
      prunedRemote: [],
      errors: [],
    },
  ]);
  assert.match(md, /- backups written: \/b\/backup-1\.bundle, \/b\/backup-2\.bundle/);
});

test("sweep prune --yes --json writes a safety bundle and notes it on stderr", async (t) => {
  const f = makeSquashRepoFixture(t);
  const cfg = writeConfig(t, { sweep: { mode: "prune" }, repos: [f.work] });
  const r = await runCli(["sweep", "--config", cfg, "--yes", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.repos[0].deletedLocal, ["feature/squash"]);
  assert.equal(doc.repos[0].backups.length, 1, "the squash deletion wrote a bundle");
  // Silent JSON mode: the safety-critical backup note goes to STDERR, never
  // into stdout's single JSON document.
  assert.match(r.stderr, /💾 backed up →/);
});

test("sweep surfaces a forge outage loudly in issue.error and exits 1", async (t) => {
  const dir = makeRepo(t, "git@github.com:owner/repo.git");
  const cfg = writeConfig(t, {
    sweep: { reportIssue: { title: "git-cleanup: branch report" } },
    repos: [dir],
  });
  const server = createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "boom" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    ...process.env,
    GITHUB_TOKEN: "gh-token",
    GITHUB_API_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  const r = await runCli(["sweep", "--config", cfg, "--json"], env);
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.issue && doc.issue.error, "issue.error is set and loud");
});

function makeSquashRepoFixture(t) {
  const f = makeSquashRepo();
  t.after(() => f.cleanup());
  return f;
}
