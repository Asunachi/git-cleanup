// Tests for support/coverage-badge.mjs — the zero-dependency coverage badge
// generator behind the README's coverage badge. The script runs the suite
// under Node's built-in --experimental-test-coverage, parses the report
// (both table formats: Node <= 24's "% Lines / % Branches" columns and
// Node 26's "line % / branch %"), maps the line percentage to a shields.io
// color, and writes coverage.json. It must refuse to write a badge when the
// suite fails — no badge for a broken tree, and the pages deploy fails too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { colorFor, fetchBaseline, parseCoverage } from "../support/coverage-badge.mjs";

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
  if (opts.fail) {
    writeFileSync(
      join(dir, "src", "fake.mjs"),
      "export function pick(x) {\n  return x > 0 ? \"pos\" : \"neg\";\n}\n"
    );
    writeFileSync(
      join(dir, "test", "fake.test.mjs"),
      "import { test } from \"node:test\";\ntest(\"always fails\", () => {\n  throw new Error(\"boom\");\n});\n"
    );
  } else if (opts.half) {
    // One of two function bodies never runs: 66.67% lines (V8 counts the
    // module-declaration lines as covered too), 100% branches.
    writeFileSync(
      join(dir, "src", "fake.mjs"),
      "export function covered() {\n  return \"yes\";\n}\nexport function uncovered() {\n  return \"no\";\n}\n"
    );
    writeFileSync(
      join(dir, "test", "fake.test.mjs"),
      "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { covered } from \"../src/fake.mjs\";\ntest(\"covers one of two functions\", () => {\n  assert.equal(covered(), \"yes\");\n});\n"
    );
  } else {
    // Covers the whole line but only one branch arm: 100% lines, 50% branches.
    writeFileSync(
      join(dir, "src", "fake.mjs"),
      "export function pick(x) {\n  return x > 0 ? \"pos\" : \"neg\";\n}\n"
    );
    writeFileSync(
      join(dir, "test", "fake.test.mjs"),
      "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { pick } from \"../src/fake.mjs\";\ntest(\"covers only the positive branch\", () => {\n  assert.equal(pick(1), \"pos\");\n});\n"
    );
  }
  return dir;
}

/**
 * Run the badge script as a child process and resolve with its result.
 * Async (not spawnSync): the gate tests serve the baseline from an HTTP stub
 * in THIS process, so the parent's event loop must stay free while the child
 * fetches it — a sync spawn would deadlock child-vs-parent.
 */
function runScript(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
}

/** A tiny JSON HTTP stub; returns { port, close }. */
async function stubServer(routes) {
  const server = createServer((req, res) => {
    const hit = routes[req.url];
    if (!hit) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(hit.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(hit.body ?? null));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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
    // The raw payload for the CI gate is written next to the badge.
    const raw = JSON.parse(readFileSync(join(dirname(out), "coverage-raw.json"), "utf8"));
    assert.equal(raw.line, 100);
    assert.equal(typeof raw.branch, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchBaseline: prefers the raw payload, falls back to the badge message, fails loudly", async () => {
  const stub = await stubServer({
    "/coverage-raw.json": { body: { line: 94.51, branch: 80.72 } },
    "/coverage.json": { body: { message: "99% lines · 81% branches" } },
  });
  try {
    const raw = await fetchBaseline(`${stub.base}/coverage-raw.json`);
    assert.equal(raw.line, 94.51);
    assert.equal(raw.via, "coverage-raw.json");

    // Raw missing (or predating raw numbers): the rounded badge message wins.
    const onlyBadge = await stubServer({
      "/coverage-raw.json": { status: 404 },
      "/coverage.json": { body: { message: "94% lines · 81% branches" } },
    });
    try {
      const fallback = await fetchBaseline(`${onlyBadge.base}/coverage-raw.json`);
      assert.equal(fallback.line, 94);
      assert.equal(fallback.via, "badge message");
    } finally {
      await onlyBadge.close();
    }

    // Neither readable: loud failure, never a silent pass.
    const dead = await stubServer({ "/coverage.json": { status: 500 } });
    try {
      await assert.rejects(
        () => fetchBaseline(`${dead.base}/coverage-raw.json`),
        /cannot fetch the deployed coverage baseline/
      );
    } finally {
      await dead.close();
    }
  } finally {
    await stub.close();
  }
});

test("coverage gate: a drop below the deployed baseline exits 1, parity passes", async (t) => {
  if (!HAS_INCLUDE_FLAG) {
    t.skip("needs --test-coverage-include (Node >= 21)");
    return;
  }
  const dir = fixture({ half: true }); // 66.67% lines
  const run = async (baselineLine) => {
    const stub = await stubServer({
      "/coverage-raw.json": { body: { line: baselineLine } },
    });
    try {
      // await INSIDE the try: `return somePromise` in a try/finally runs the
      // finally immediately (it does not await the returned promise), which
      // would close the stub before the child's fetch — ECONNREFUSED.
      return await runScript(
        [
          SCRIPT,
          "--out",
          join(dir, "badge.json"),
          "--baseline-url",
          `${stub.base}/coverage-raw.json`,
          "--",
          join(dir, "test", "fake.test.mjs"),
        ],
        dir,
        plainEnv()
      );
    } finally {
      await stub.close();
    }
  };
  const fail = await run(75);
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /coverage regression: 66\.67% lines is below the deployed baseline 75%/);
  const pass = await run(40);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /no regression/);
});

test("coverage gate: falls back to the badge message and fails loudly when nothing is reachable", async (t) => {
  if (!HAS_INCLUDE_FLAG) {
    t.skip("needs --test-coverage-include (Node >= 21)");
    return;
  }
  const dir = fixture({ half: true }); // 66.67% lines
  const run = async (routes) => {
    const stub = await stubServer(routes);
    try {
      // await INSIDE the try — see the note in the sibling gate test: a
      // bare `return` would run the finally (and close the stub) immediately.
      return await runScript(
        [
          SCRIPT,
          "--out",
          join(dir, "badge.json"),
          "--baseline-url",
          `${stub.base}/coverage-raw.json`,
          "--",
          join(dir, "test", "fake.test.mjs"),
        ],
        dir,
        plainEnv()
      );
    } finally {
      await stub.close();
    }
  };

  // Raw absent, badge message "40% lines": 66.67 >= 40, passes via the fallback.
  const fbPass = await run({ "/coverage.json": { body: { message: "40% lines · 90% branches" } } });
  assert.equal(fbPass.status, 0, fbPass.stderr);
  assert.match(fbPass.stdout, /\(badge message\)/);

  // Raw absent, badge message "60% lines": 66.67 < 60 is false, so instead
  // the raw file stays the arbiter — the fallback must pass: use a badge
  // message above the achieved coverage to prove the fallback drives the gate.
  const fbFail = await run({ "/coverage.json": { body: { message: "90% lines · 90% branches" } } });
  assert.equal(fbFail.status, 1);
  assert.match(fbFail.stderr, /coverage regression: 66\.67% lines is below the deployed baseline 90% \(badge message\)/);

  // Neither reachable: loud failure, never a silent pass.
  const dead = await run({});
  assert.equal(dead.status, 1);
  assert.match(dead.stderr, /cannot fetch the deployed coverage baseline/);
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
