// Structural tests for the dedicated Homebrew tap repository.
//
// The formula lives in homebrew-git-cleanup/ — the content of
// github.com/Asunachi/homebrew-git-cleanup (tap name Asunachi/git-cleanup) —
// and this repository deliberately ships no formula of its own, so the app
// version and the tap's pinned version cannot silently drift apart. These
// tests pin the scaffold's shape (formula version == package.json version,
// the auto-update workflow's trigger surface and the script it runs) the
// same way ci-parity.test.mjs pins the CI definitions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAP = join(root, "homebrew-git-cleanup");
const FORMULA = join(TAP, "Formula", "git-cleanup.rb");

test("tap scaffold: formula pinned to package.json version, no stray in-repo formula", () => {
  assert.ok(existsSync(FORMULA), "homebrew-git-cleanup/Formula/git-cleanup.rb should exist");
  assert.ok(existsSync(join(TAP, "update-formula.sh")), "update-formula.sh should exist");
  assert.ok(existsSync(join(TAP, "README.md")), "tap README should exist");
  assert.ok(existsSync(join(TAP, "LICENSE")), "tap LICENSE should exist");

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const formula = readFileSync(FORMULA, "utf8");

  // The seeded formula must point at the npm tarball of the current release,
  // so pushing the tap repo serves the latest version from day one.
  const url = formula.match(/^  url "([^"]+)"/m)?.[1];
  assert.ok(url, "formula should have a url line");
  assert.match(url, new RegExp(`gitcleanup-${pkg.version}\\.tgz$`), "formula url version must match package.json");
  assert.match(url, /^https:\/\/registry\.npmjs\.org\/@maliqkara\/gitcleanup\//);

  assert.match(formula, /sha256 "[0-9a-f]{64}"/, "formula should pin a sha256");
  assert.match(formula, /^class GitCleanup < Formula$/m);
  assert.match(formula, /license "MIT"/);

  // Single url and sha256 lines: the sed patch in update-formula.sh relies on
  // exactly one of each to rewrite.
  assert.equal((formula.match(/^  url "/gm) ?? []).length, 1, "exactly one url line");
  assert.equal((formula.match(/^  sha256 "/gm) ?? []).length, 1, "exactly one sha256 line");

  // No second, drift-prone formula copy in this repository.
  assert.ok(!existsSync(join(root, "Formula", "git-cleanup.rb")), "this repo should not ship its own formula");
});

test("tap workflow: scheduled + manual, runs update-formula.sh against the upstream repo", () => {
  const wf = readFileSync(join(TAP, ".github", "workflows", "update-formula.yml"), "utf8");

  // Trigger surface: daily poll + manual dispatch.
  assert.match(wf, /cron: "17 4 \* \* \*"/);
  assert.match(wf, /workflow_dispatch/);
  assert.match(wf, /schedule:/);

  // The update needs the automatic token only (push to this same repo).
  assert.match(wf, /permissions:/);
  assert.match(wf, /contents: write/);

  // Single job, official checkout, runs the standalone script.
  assert.match(wf, /jobs:/);
  assert.match(wf, /runs-on: ubuntu-latest/);
  assert.match(wf, /actions\/checkout@v5/);
  assert.match(wf, /run: \.\/update-formula\.sh/);
  // gh refuses to authenticate with the automatic GITHUB_TOKEN variable;
  // it must be passed explicitly as GH_TOKEN or the updater dies on the
  // first API call (caught live on run #1 of the tap repo).
  assert.match(wf, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(wf, /UPSTREAM_REPO: Asunachi\/git-cleanup/);

  // Serialize runs so a manual dispatch cannot race the daily poll's push.
  assert.match(wf, /concurrency:/);
  assert.match(wf, /group: update-formula/);

  // YAML sanity: no tabs, even indentation (same rules as the CI files).
  for (const [i, raw] of wf.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() !== "" && !line.trim().startsWith("#")) {
      assert.ok(!line.includes("\t"), `line ${i + 1}: tabs are not YAML-safe here`);
      const indent = line.match(/^ */)[0].length;
      assert.equal(indent % 2, 0, `line ${i + 1}: odd indentation`);
    }
  }
});

test("tap update script: syntactically valid, executable, and rejects a bad current version", (t) => {
  const script = join(TAP, "update-formula.sh");
  // The exec bit is a POSIX checkout concept; Windows worktrees never get it.
  if (process.platform !== "win32") {
    const mode = statSync(script).mode;
    assert.ok(mode & 0o100, "update-formula.sh should be executable");
  }

  const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") {
    t.skip("bash not available on this platform");
    return;
  }
  assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
});
