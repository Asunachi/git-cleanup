#!/usr/bin/env node
// Runs the test suite under Node's built-in coverage reporter
// (--experimental-test-coverage — zero dependencies) and writes
// coverage.json: the shields.io endpoint payload the README coverage badge
// renders. The file is NOT committed: .github/workflows/pages.yml runs this
// script on every deploy and serves the JSON from the Pages site
// (https://asunachi.github.io/git-cleanup/coverage.json), so the badge
// always describes exactly the tree the playground publishes.
//
// The number is honest by construction:
//   - the suite must PASS — a failing run writes nothing and exits 1
//     (no badge for a broken tree, and the pages deploy fails loudly);
//   - coverage is measured only over src/** (--test-coverage-include),
//     never the tests themselves.
//
// Requires Node >= 21 for --test-coverage-include; the pages workflow pins
// Node 22. Both report table formats are parsed: Node 22/24's
// "File | % Lines | % Statements | % Functions | % Branches" and Node 26's
// "file | line % | branch % | funcs %".
//
// The badge payload (coverage.json) stays shields-compatible; the raw
// percentages are written next to it as coverage-raw.json ({ line, branch })
// so CI can gate precisely instead of reading rounded integers.
//
// Usage:
//   node support/coverage-badge.mjs [--out <file>] [--baseline-url <url>] [-- <node --test args>]
//
// --baseline-url <url>  gate mode: fetch the deployed baseline (a
//   coverage-raw.json URL; falls back to the badge payload's rounded line
//   % when the raw file predates it or is unavailable) and exit 1 if this
//   tree's line coverage drops below it — untested code can't land
//   silently. Used by the ci.yml coverage-gate job.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Strip reporter prefixes (ℹ, TAP #) and ANSI codes from a report line. */
export function cleanLine(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\s*(ℹ|#)\s*/, "");
}

/**
 * Parse a coverage report (any Node >= 20 table format) into
 * { line, branch } percentages for the "all files" row.
 */
export function parseCoverage(report) {
  const start = report.indexOf("start of coverage report");
  const end = report.indexOf("end of coverage report");
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no coverage report found (was --experimental-test-coverage passed?)');
  }
  const rows = report
    .slice(start, end)
    .split("\n")
    .map(cleanLine)
    .filter((l) => l.includes("|"));

  const header = rows.find((l) => /%/.test(l) && /\bfile\b/i.test(l));
  if (!header) throw new Error("coverage report has no header row");
  const cols = header.split("|").map((c) => c.trim());
  const colIndex = (name) => {
    const i = cols.findIndex((c) => c.toLowerCase() === name.toLowerCase());
    if (i === -1) throw new Error(`coverage report header lacks "${name}"`);
    return i;
  };
  // Node 26: "file | line % | branch % | funcs % | uncovered lines"
  // Node <= 24: "File | % Lines | % Statements | % Functions | % Branches | ..."
  let lineIdx;
  let branchIdx;
  try {
    lineIdx = colIndex("line %");
    branchIdx = colIndex("branch %");
  } catch {
    lineIdx = colIndex("% lines");
    branchIdx = colIndex("% branches");
  }

  const all = rows.find(
    (l) => l.split("|")[0].trim().toLowerCase() === "all files"
  );
  if (!all) throw new Error('coverage report has no "all files" row');
  const cells = all.split("|").map((c) => c.trim());
  const num = (i) => {
    const v = parseFloat(cells[i]);
    if (!Number.isFinite(v)) {
      throw new Error(`coverage value at column ${i} is not a number: "${cells[i]}"`);
    }
    return v;
  };
  return { line: num(lineIdx), branch: num(branchIdx) };
}

/** shields.io color for a line-coverage percentage. */
export function colorFor(line) {
  if (line >= 95) return "brightgreen";
  if (line >= 90) return "green";
  if (line >= 80) return "yellowgreen";
  if (line >= 70) return "yellow";
  if (line >= 60) return "orange";
  return "red";
}

/** Run the test suite with Node's built-in coverage; returns the spawn result. */
export function runCoverage(extraArgs = []) {
  return spawnSync(
    process.execPath,
    [
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-include=src/**",
      ...extraArgs,
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
}

/**
 * Gate tolerance in percentage points. Coverage is not perfectly
 * deterministic across CI runs: identical trees have measured ~0.1pp apart
 * live (pages deploy 94.34% vs gate 94.25% on the same commit), so a zero
 * tolerance gate fails no-op changes. 0.5pp is 5x the observed noise and
 * still catches real regressions — an untested 50-line addition to src/
 * (~2,000 lines) drops coverage by ~2.4pp.
 */
export const GATE_TOLERANCE_PP = 0.5;

/**
 * Fetch the deployed line-coverage baseline for the gate.
 *
 * Prefers coverage-raw.json ({ line }); falls back to the badge payload's
 * rounded "N% lines" message (the raw file predates it or is unavailable),
 * and fails loudly when neither is readable. Returns { line, via }.
 */
export async function fetchBaseline(url) {
  const badgeUrl = url.replace(/coverage-raw\.json$/, "coverage.json");
  const read = async (u) => {
    try {
      const res = await fetch(u, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
  const raw = await read(url);
  if (raw && typeof raw.line === "number") {
    return { line: raw.line, via: "coverage-raw.json" };
  }
  const badge = await read(badgeUrl);
  const m = badge && typeof badge.message === "string"
    ? badge.message.match(/^(\d+)% lines/)
    : null;
  if (m) {
    return { line: Number(m[1]), via: "badge message" };
  }
  throw new Error(
    `cannot fetch the deployed coverage baseline from ${url} (raw payload and badge both unreadable)`
  );
}

/** Run the suite, parse coverage, and write the badge + raw payloads. */
export function generateBadge(outFile, extraArgs = []) {
  const r = runCoverage(extraArgs);
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "")
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
    console.error("test suite failed under coverage — no badge written:");
    console.error(tail);
    console.error(
      "note: coverage badge generation needs --test-coverage-include (Node >= 21);"
    );
    console.error("the pages workflow pins Node 22.");
    process.exit(1);
  }
  const { line, branch } = parseCoverage(`${r.stdout}\n${r.stderr}`);
  const payload = {
    schemaVersion: 1,
    label: "coverage",
    message: `${Math.round(line)}% lines · ${Math.round(branch)}% branches`,
    color: colorFor(line),
    // The badge only changes when the deployed tree changes.
    cacheSeconds: 86400,
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
  // Raw percentages for the CI gate (coverage-raw.json), rounded to 2dp so
  // identical trees compare equal.
  const raw = {
    line: Math.round(line * 100) / 100,
    branch: Math.round(branch * 100) / 100,
  };
  writeFileSync(
    join(dirname(outFile), "coverage-raw.json"),
    `${JSON.stringify(raw, null, 2)}\n`
  );
  return { payload, line, branch };
}

async function main() {
  const argv = process.argv.slice(2);
  let out = join(root, "coverage.json");
  let baselineUrl = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = resolve(argv[++i]);
    } else if (argv[i] === "--baseline-url") {
      baselineUrl = argv[++i];
    } else if (argv[i] === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else if (argv[i] === "--help") {
      console.log(
        "usage: node support/coverage-badge.mjs [--out <file>] [--baseline-url <url>] [-- <node --test args>]"
      );
      return;
    } else {
      passthrough.push(argv[i]);
    }
  }
  const { payload, line } = generateBadge(out, passthrough);
  if (baselineUrl) {
    const baseline = await fetchBaseline(baselineUrl);
    if (line < baseline.line - GATE_TOLERANCE_PP) {
      console.error(
        `coverage regression: ${line.toFixed(2)}% lines is below the deployed baseline ` +
          `${baseline.line}% (${baseline.via}) — new code shipped without tests. ` +
          `Add tests, or move the untested code behind a tested seam.`
      );
      process.exit(1);
    }
    console.log(
      `coverage gate: ${line.toFixed(2)}% lines ≥ deployed baseline ` +
        `${baseline.line}% (${baseline.via}, ${GATE_TOLERANCE_PP}pp tolerance) — no regression`
    );
  }
  console.log(`coverage: ${payload.message} → ${out} (${payload.color})`);
}

if (process.argv[1] && process.argv[1].endsWith("coverage-badge.mjs")) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
