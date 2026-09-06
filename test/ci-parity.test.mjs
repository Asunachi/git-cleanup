// Structural + parity tests for the two CI definitions.
//
// .github/workflows/ci.yml is the source of truth for CI behavior; the
// .gitlab-ci.yml template exists to mirror it for GitLab projects. These
// tests pin the GitHub file's structure (the same way gitlab-ci.test.mjs
// pins the template) and then assert the essential surface of both files
// stays in lockstep — node matrix, fuzz volume, CLI smoke, playground
// freshness gate, and the scheduled sweep — so a change to one cannot
// silently orphan the other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI = join(root, ".github", "workflows", "ci.yml");
const GITLAB = join(root, ".gitlab-ci.yml");

function lines(file) {
  return readFileSync(file, "utf8").split("\n");
}

/** Non-blank, non-comment lines with their indentation. */
function codeLines(file) {
  return lines(file)
    .map((l, i) => ({ text: l, indent: l.match(/^ */)[0].length, num: i + 1 }))
    .filter((l) => l.text.trim() !== "" && !l.text.trim().startsWith("#"));
}

test("ci.yml structure: expected top-level keys and sane YAML indentation", () => {
  assert.ok(existsSync(CI), ".github/workflows/ci.yml should exist");
  const code = codeLines(CI);
  assert.ok(code.length > 0);

  for (const l of code) {
    assert.ok(!l.text.includes("\t"), `line ${l.num}: tabs are not YAML-safe here`);
    assert.equal(l.indent % 2, 0, `line ${l.num}: odd indentation`);
  }

  const top = code.filter((l) => l.indent === 0).map((l) => l.text.split(":")[0]);
  assert.deepEqual(top, ["name", "on", "concurrency", "jobs"]);

  // Both jobs exist and the matrix covers 3 OSes × 3 Node versions.
  const text = readFileSync(CI, "utf8");
  assert.match(text, /\n  test:\n/);
  assert.match(text, /\n  playground-fresh:\n/);
  assert.match(text, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(text, /node-version: \[18, 20, 22\]/);
  // Scheduled deep sweep + manual dispatch, mirroring the gitlab schedule.
  assert.match(text, /cron: "23 3 \* \* \*"/);
  assert.match(text, /workflow_dispatch/);
});

test("ci.yml runs only real commands and carries the deep sweep", () => {
  const text = readFileSync(CI, "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  // Every npm command the workflow runs must exist as a script.
  for (const script of ["test", "sync:playground"]) {
    assert.ok(pkg.scripts[script], `package.json has the ${script} script ci.yml runs`);
  }
  assert.ok(existsSync(join(root, "bin", "git-cleanup.mjs")), "ci.yml runs bin/git-cleanup.mjs");

  // The same CLI smoke and playground-fresh gates as the gitlab template.
  assert.match(text, /node bin\/git-cleanup\.mjs --version/);
  assert.match(text, /--help >\/dev\/null/);
  assert.match(text, /scan --repo \/nonexistent/);
  assert.match(text, /npm run sync:playground/);
  assert.match(text, /git diff --exit-code --quiet -- index\.html/);
  // The deep parity sweep the gitlab template must track.
  assert.match(text, /FUZZ_CASES: "50000"/);
});

test("ci.yml and .gitlab-ci.yml cannot drift apart", () => {
  const ci = readFileSync(CI, "utf8");
  const gl = readFileSync(GITLAB, "utf8");

  // Same Node matrix.
  const ciNodes = [...ci.matchAll(/node-version: \[([^\]]+)\]/g)].flatMap((m) =>
    m[1].split(",").map((s) => s.trim())
  );
  const glNodes = [...gl.matchAll(/"node:(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual([...ciNodes].sort(), [...glNodes].sort(), "node matrix must match");

  // Same test suite volume.
  assert.match(ci, /FUZZ_CASES: "50000"/);
  assert.match(gl, /FUZZ_CASES: "50000"/);

  // Same CLI smoke.
  for (const needle of ["--version", "--help", "/nonexistent"]) {
    assert.ok(ci.includes(needle), `ci.yml smoke includes ${needle}`);
    assert.ok(gl.includes(needle), `gitlab template smoke includes ${needle}`);
  }

  // Same playground freshness gate.
  for (const needle of ["npm run sync:playground", "git diff --exit-code --quiet -- index.html"]) {
    assert.ok(ci.includes(needle), `ci.yml freshness includes ${needle}`);
    assert.ok(gl.includes(needle), `gitlab template freshness includes ${needle}`);
  }

  // Same scheduled deep sweep: GitHub via cron + dispatch, GitLab via
  // schedule pipelines with a per-run seed.
  assert.match(ci, /cron:/);
  assert.match(gl, /CI_PIPELINE_SOURCE == "schedule"/);
  assert.match(gl, /FUZZ_SEED=\$CI_PIPELINE_IID/);

  // OS coverage: ci.yml runs the matrix on all three; the gitlab template
  // must at least document the self-hosted-runner story for Windows/macOS.
  assert.match(ci, /windows-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(gl, /windows/);
  assert.match(gl, /macos/);

  // Branch-hygiene report channel exists on both sides: the gitlab scan job
  // and the GitHub scan-report action (the report-issue workflow uses it).
  assert.match(gl, /scan --check --repo/);
  assert.ok(
    existsSync(join(root, ".github", "actions", "scan-report", "run.sh")),
    "GitHub's equivalent of the scan job exists"
  );

  // Issue reporting is mirrored: both sides keep one issue titled exactly
  // "git-cleanup: branch report" current, rendered by the same markdown
  // renderer, via a scheduled create-or-update job — and both sides drive
  // it through the SAME CLI command (one command, any forge).
  assert.match(gl, /report-issue:/);
  assert.match(gl, /git-cleanup: branch report/);
  assert.match(gl, /bin\/git-cleanup\.mjs report-issue/);
  assert.match(gl, /--title "git-cleanup: branch report"/);
  // Both sides rehearse with --dry-run before the real post, so a broken
  // token, API change, or failed search fails the run loudly instead of
  // silently skipping the report.
  assert.match(gl, /report-issue[^\n]*--dry-run/);
  const gw = readFileSync(join(root, ".github", "workflows", "report-issue.yml"), "utf8");
  assert.match(gw, /cron:/);
  assert.match(gw, /workflow_dispatch/);
  assert.match(gw, /issues: write/);
  assert.match(gw, /bin\/git-cleanup\.mjs report-issue/);
  assert.match(gw, /bin\/git-cleanup\.mjs report-issue report\.md --dry-run/);
  assert.match(gw, /scan-report\/report\.mjs/); // same markdown renderer
  // The command exists and carries the shared default title.
  assert.ok(existsSync(join(root, "src", "report-issue.mjs")));
  const cmd = readFileSync(join(root, "src", "report-issue.mjs"), "utf8");
  assert.match(cmd, /git-cleanup: branch report/);
  // The composite action stays a shipped deliverable for users' own workflows.
  const action = readFileSync(join(root, ".github", "actions", "scan-report", "action.yml"), "utf8");
  assert.match(action, /git-cleanup: branch report/);
});

test("pages.yml structure: deploys the playground on main pushes and dispatch", () => {
  const PAGE = join(root, ".github", "workflows", "pages.yml");
  assert.ok(existsSync(PAGE), ".github/workflows/pages.yml should exist");
  const code = codeLines(PAGE);
  assert.ok(code.length > 0);

  for (const l of code) {
    assert.ok(!l.text.includes("\t"), `line ${l.num}: tabs are not YAML-safe here`);
    assert.equal(l.indent % 2, 0, `line ${l.num}: odd indentation`);
  }

  const top = code.filter((l) => l.indent === 0).map((l) => l.text.split(":")[0]);
  assert.deepEqual(top, ["name", "on", "permissions", "concurrency", "jobs"]);

  const text = readFileSync(PAGE, "utf8");
  // Main pushes and manual dispatch deploy (the release workflow pushes the
  // release commit to main before tagging, so the site mirrors releases via
  // the main trigger). Tags deliberately do NOT trigger: a tag push lands on
  // the same commit as the release's main push, and two same-commit pages
  // runs cancel each other mid-deploy under the concurrency guard — a known
  // Pages artifact race that failed deploys; a retroactive old tag would
  // also roll the site back to an ancient engine.
  const onBlock = text.slice(text.indexOf("on:"), text.indexOf("permissions:"));
  assert.match(onBlock, /branches: \[main\]/);
  assert.match(onBlock, /workflow_dispatch/);
  assert.ok(!/^\s+tags:/m.test(onBlock), "pages must not trigger on tags (see the race note)");
  // The deploy actually republishes the engine: it regenerates index.html
  // from src/engine.mjs and refuses to publish a stale copy.
  assert.match(text, /npm run sync:playground/);
  assert.match(text, /git diff --exit-code --quiet -- index\.html/);
  // Official Pages actions, with the permissions they need.
  assert.match(text, /actions\/upload-pages-artifact@v3/);
  assert.match(text, /actions\/deploy-pages@v4/);
  assert.match(text, /pages: write/);
  assert.match(text, /id-token: write/);
  // The site artifact it publishes is exactly what a visitor needs.
  assert.match(text, /cp index\.html _site\//);
  // The npm script it runs must exist.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.scripts["sync:playground"], "package.json has the sync:playground script pages.yml runs");
  // The deploy also re-runs the suite under Node's built-in coverage and
  // serves the result for the README badge, so a broken tree can't publish
  // and the badge always describes the deployed tree.
  assert.match(text, /npm run coverage/);
  assert.match(text, /cp coverage\.json _site\//);
  assert.ok(pkg.scripts["coverage"], "package.json has the coverage script pages.yml runs");
});
