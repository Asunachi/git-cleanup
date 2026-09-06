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
// Usage: node support/coverage-badge.mjs [--out <file>] [-- <node --test args>]

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

/** Run the suite, parse coverage, and write the badge payload. */
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
  return payload;
}

function main() {
  const argv = process.argv.slice(2);
  let out = join(root, "coverage.json");
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = resolve(argv[++i]);
    } else if (argv[i] === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else if (argv[i] === "--help") {
      console.log(
        "usage: node support/coverage-badge.mjs [--out <file>] [-- <node --test args>]"
      );
      return;
    } else {
      passthrough.push(argv[i]);
    }
  }
  const payload = generateBadge(out, passthrough);
  console.log(
    `coverage: ${payload.message} → ${out} (${payload.color})`
  );
}

if (process.argv[1] && process.argv[1].endsWith("coverage-badge.mjs")) {
  main();
}
