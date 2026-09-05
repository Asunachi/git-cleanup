// Structural tests for the .gitlab-ci.yml template. Without a YAML parser
// (zero-dependency rule), we pin what matters: the file parses as far as
// indentation consistency goes, the jobs mirror the GitHub CI workflow, and
// every command the template runs actually exists in this repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, ".gitlab-ci.yml");

function lines() {
  return readFileSync(FILE, "utf8").split("\n");
}

/** Non-blank, non-comment lines with their indentation. */
function codeLines() {
  return lines()
    .map((l, i) => ({ text: l, indent: l.match(/^ */)[0].length, num: i + 1 }))
    .filter((l) => l.text.trim() !== "" && !l.text.trim().startsWith("#"));
}

test("gitlab-ci template exists with the expected jobs, stages, and sane indentation", () => {
  assert.ok(existsSync(FILE), ".gitlab-ci.yml should exist");
  const code = codeLines();
  assert.ok(code.length > 0);

  // YAML in this repo is 2-space indented; tabs and odd indents would break
  // parsing on GitLab.
  for (const l of code) {
    assert.ok(!l.text.includes("\t"), `line ${l.num}: tabs are not YAML-safe here`);
    assert.equal(l.indent % 2, 0, `line ${l.num}: odd indentation`);
  }

  // Top-level keys (indent 0) are exactly the documented surface.
  const top = code.filter((l) => l.indent === 0).map((l) => l.text.replace(":", "").trim());
  assert.deepEqual(top, ["variables", "stages", "test", "cli-smoke", "playground-fresh", "deep-sweep", "scan", "report-issue"]);

  // The stages list covers every stage keyword used by jobs.
  const stagesLine = code.find((l) => l.text.startsWith("stages:"));
  const stageNames = ["test", "freshness", "scan"];
  const declared = lines().slice(stagesLine.num).filter((l) => /^ {2}- /.test(l)).map((l) => l.trim().slice(2));
  assert.deepEqual(declared, stageNames);
  for (const job of ["test:", "cli-smoke:", "playground-fresh:", "deep-sweep:", "scan:", "report-issue:"]) {
    assert.ok(code.some((l) => l.text === job), `job ${job} has a stage`);
  }
});

test("script items are strings, never YAML mappings (the `: ` trap)", () => {
  // A `: ` (colon + space) inside a plain YAML scalar silently splits it
  // into a key/value mapping — e.g. --title "git-cleanup: branch report".
  // GitLab would then reject the job's script. This repo has no YAML
  // parser (zero-dependency rule), so guard the hazard structurally:
  // script items must be quoted when they contain `: `.
  const code = codeLines();
  // Command lines (script items) are plain scalars; rules entries are
  // intentionally mappings, so only check the `- node ...` lines.
  const scriptItems = code.filter(
    (l) => l.indent === 4 && l.text.trim().startsWith("- node ")
  );
  assert.ok(scriptItems.length >= 3, "the template has command lines to check");
  for (const l of scriptItems) {
    const body = l.text.trim().slice(2);
    if (body.includes(": ") && !/^['"]/.test(body)) {
      assert.fail(`line ${l.num}: script item contains ": " but is not quoted: ${body}`);
    }
  }
});

test("gitlab-ci mirrors the GitHub CI matrix and the commands it runs exist", () => {
  const text = readFileSync(FILE, "utf8");

  // Node matrix mirrors .github/workflows/ci.yml's node-version list.
  for (const v of ["node:18", "node:20", "node:22"]) {
    assert.ok(text.includes(`"${v}"`), `matrix should cover ${v}`);
  }
  // The same deep parity sweep the GitHub CI runs.
  assert.match(text, /FUZZ_CASES: "50000"/);
  // The same CLI smoke steps.
  assert.match(text, /--version/);
  assert.match(text, /scan --repo \/nonexistent/);
  // The same playground-freshness gate.
  assert.match(text, /npm run sync:playground/);
  assert.match(text, /git diff --exit-code --quiet -- index\.html/);
  // Scheduled deep sweep with a per-pipeline seed, mirroring the nightly job.
  assert.match(text, /CI_PIPELINE_SOURCE == "schedule"/);
  assert.match(text, /FUZZ_SEED=\$CI_PIPELINE_IID/);

  // Every command the template runs must exist in this repository.
  assert.ok(existsSync(join(root, "bin", "git-cleanup.mjs")), "template runs bin/git-cleanup.mjs");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const script of ["test", "sync:playground"]) {
    assert.ok(pkg.scripts[script], `package.json has the ${script} script the template runs`);
  }
});

test("scan job fails the pipeline when branches are prunable, offline-safe", () => {
  const text = readFileSync(FILE, "utf8");
  // The scan targets the checked-out repository...
  assert.match(text, /CI_PROJECT_DIR/);
  // ...uses --check (exit 2 = prunable) and turns it into a failed pipeline.
  assert.match(text, /scan --check --repo/);
  assert.match(text, /code=\$\?/);
  assert.match(text, /exit 2/);
  // Scheduled by default, manual via the play button otherwise.
  assert.match(text, /when: on_success/);
  assert.match(text, /when: manual/);
  // Full history for merge detection (mirrors the action's unshallow).
  assert.match(text, /GIT_DEPTH: 0/);
});
