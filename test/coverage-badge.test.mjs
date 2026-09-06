// Tests for support/coverage-badge.mjs — the zero-dependency coverage badge
// generator behind the README's coverage badge. The script runs the suite
// under Node's built-in --experimental-test-coverage, parses the report
// (both table formats: Node <= 24's "% Lines / % Branches" columns and
// Node 26's "line % / branch %"), maps the line percentage to a shields.io
// color, and writes coverage.json. It must refuse to write a badge when the
// suite fails — no badge for a broken tree, and the pages deploy fails too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { colorFor, parseCoverage } from "../support/coverage-badge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "support", "coverage-badge.mjs");

// --test-coverage-include exists on Node >= 21 (the pages workflow pins 22).
// On older Nodes the script refuses to run — correctly, since without the
// include filter the number would count the tests themselves — so the e2e
// tests skip there; the parse/color unit tests above run everywhere.
const HAS_INCLUDE_FLAG = Number(process.versions.node.split(".")[0]) >= 21;

// The inner `node --test` the script spawns would otherwise be skipped: the
// outer test runner marks its children with NODE_TEST_CONTEXT, and Node
// refuses recursive test runs from inside a test file ("skipping running
// files", exit 0, no output). Production runs never have that var set, so
// the e2e tests spawn the script with a clean env to match reality.
function plainEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** A coverage report in Node 26's table format (as observed live). */
const NODE26_REPORT = `
ℹ start of coverage report
ℹ --------------------------------------------------------------------------------------------------------------------------------------------------------
ℹ file                   | line % | branch % | funcs % | uncovered lines
ℹ --------------------------------------------------------------------------------------------------------------------------------------------------------
ℹ src                    |        |          |         |
ℹ  classify.mjs          | 100.00 |   100.00 |  100.00 |
ℹ  config.mjs            |  91.38 |    89.25 |  100.00 | 46-50 103-105
ℹ  forge.mjs             |  59.04 |   100.00 |    0.00 | 82-90 98-114
ℹ all files              |  46.85 |    90.45 |   20.83 |
ℹ --------------------------------------------------------------------------------------------------------------------------------------------------------
ℹ end of coverage report
`;

/** A coverage report in Node <= 24's table format, with TAP-style prefixes. */
const OLD_REPORT = `
# start of coverage report
# -------------------------------------------------------------------------
# File                                                 | % Lines | % Statements | % Functions | % Branches | Lines | Uncovered Line #s
# -------------------------------------------------------------------------
# test/foo.test.mjs                                    |     100 |          100 |          100 |        100 |    15 |
# src/foo.mjs                                          |    93.33 |         93.33 |        100.00 |      90.00 |    30 |
# -------------------------------------------------------------------------
# All files                                            |    93.33 |         93.33 |        100.00 |      90.00 |    45 |
# end of coverage report
`;

test("parseCoverage: Node 26 table format", () => {
  assert.deepEqual(parseCoverage(NODE26_REPORT), { line: 46.85, branch: 90.45 });
});

test("parseCoverage: Node <= 24 table format (different columns, TAP prefixes)", () => {
  assert.deepEqual(parseCoverage(OLD_REPORT), { line: 93.33, branch: 90 });
});

test("parseCoverage: rejects reports without an 'all files' row", () => {
  const broken = NODE26_REPORT.replace(/all files.*/, "");
  assert.throws(() => parseCoverage(broken), /all files/);
});

test("parseCoverage: rejects output with no coverage report at all", () => {
  assert.throws(() => parseCoverage("ℹ tests 1\nℹ pass 1\n"), /coverage report/);
});

test("colorFor: shields.io thresholds on the line percentage", () => {
  assert.equal(colorFor(100), "brightgreen");
  assert.equal(colorFor(95), "brightgreen");
  assert.equal(colorFor(94.9), "green");
  assert.equal(colorFor(90), "green");
  assert.equal(colorFor(89.9), "yellowgreen");
  assert.equal(colorFor(80), "yellowgreen");
  assert.equal(colorFor(79.9), "yellow");
  assert.equal(colorFor(70), "yellow");
  assert.equal(colorFor(69.9), "orange");
  assert.equal(colorFor(60), "orange");
  assert.equal(colorFor(59.9), "red");
});

/** Build a throwaway package: src/fake.mjs + a test that covers it. */
function fixture(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gc-cov-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(
    join(dir, "src", "fake.mjs"),
    "export function pick(x) {\n  return x > 0 ? \"pos\" : \"neg\";\n}\n"
  );
  if (opts.fail) {
    writeFileSync(
      join(dir, "test", "fake.test.mjs"),
      "import { test } from \"node:test\";\ntest(\"always fails\", () => {\n  throw new Error(\"boom\");\n});\n"
    );
  } else {
    // Covers the whole line but only one branch arm: 100% lines, 50% branches.
    writeFileSync(
      join(dir, "test", "fake.test.mjs"),
      "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { pick } from \"../src/fake.mjs\";\ntest(\"covers only the positive branch\", () => {\n  assert.equal(pick(1), \"pos\");\n});\n"
    );
  }
  return dir;
}

test("generateBadge: writes the shields.io payload from a real coverage run", (t) => {
  if (!HAS_INCLUDE_FLAG) {
    t.skip("needs --test-coverage-include (Node >= 21)");
    return;
  }
  const dir = fixture();
  const out = join(dir, "badge.json");
  try {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--out", out, "--", join(dir, "test", "fake.test.mjs")],
      { cwd: dir, encoding: "utf8", env: plainEnv() }
    );
    assert.equal(r.status, 0, r.stderr);
    // The ternary's line is fully executed; branch-slot accounting is
    // V8-internal (2 or 3 slots depending on version), so only the line
    // percentage and its color are exact.
    assert.match(r.stdout, /100% lines · \d+% branches/);
    const badge = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(badge.schemaVersion, 1);
    assert.equal(badge.label, "coverage");
    assert.match(badge.message, /^100% lines · \d+% branches$/);
    assert.equal(badge.color, "brightgreen"); // line >= 95
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateBadge: a failing suite writes nothing and exits 1", (t) => {
  if (!HAS_INCLUDE_FLAG) {
    t.skip("needs --test-coverage-include (Node >= 21)");
    return;
  }
  const dir = fixture({ fail: true });
  const out = join(dir, "badge.json");
  try {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--out", out, "--", join(dir, "test", "fake.test.mjs")],
      { cwd: dir, encoding: "utf8", env: plainEnv() }
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no badge written/);
    assert.ok(!existsSync(out), "no badge payload may be written for a failing suite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("README carries the coverage badge pointing at the Pages-served payload", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /img\.shields\.io\/endpoint/);
  assert.match(readme, /asunachi\.github\.io\/git-cleanup\/coverage\.json/);
  assert.match(readme, /npm run coverage/);
});
