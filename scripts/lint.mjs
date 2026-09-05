#!/usr/bin/env node
// Zero-dependency linter: syntax-checks every JS file with `node --check` and
// enforces a few formatting invariants (no tabs, no trailing whitespace, final
// newline). Keeps the project's "no dependencies" promise while still catching
// sloppy edits. Run with `npm run lint`; the test suite runs it too
// (test/lint.test.mjs), so `npm test` can never go green on a lint violation.
//
// Usage: node scripts/lint.mjs [path...]   (default: everything under the repo)

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".freebuff"]);
const JS_FILE = /\.(mjs|js|cjs)$/;

/** Every JS file under `dir`, sorted for stable output. */
export function collectFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const file = join(dir, name);
    if (statSync(file).isDirectory()) {
      collectFiles(file, out);
    } else if (JS_FILE.test(name)) {
      out.push(file);
    }
  }
  return out;
}

/** Lint one file; returns an array of problem strings (empty = clean). */
export function lintFile(file) {
  const problems = [];
  const syntax = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (syntax.status !== 0) {
    problems.push(
      (syntax.stderr || syntax.stdout || "syntax error").trim().split("\n").pop()
    );
  }
  const text = readFileSync(file, "utf8");
  // Normalize CRLF (Windows checkouts) before the whitespace checks.
  const norm = text.replace(/\r/g, "");
  if (!norm.endsWith("\n")) problems.push("missing final newline");
  norm.split("\n").forEach((line, i) => {
    if (/[ \t]+$/.test(line)) {
      problems.push(`trailing whitespace on line ${i + 1}`);
    }
    if (line.includes("\t")) {
      problems.push(`tab character on line ${i + 1}`);
    }
  });
  return problems;
}

/** Lint every JS file; returns { errors: [{ file, problems }] } (clean files omitted). */
export function lintAll(files = collectFiles()) {
  const errors = [];
  for (const file of files) {
    const problems = lintFile(file);
    if (problems.length > 0) {
      errors.push({ file: relative(ROOT, file), problems });
    }
  }
  return { errors };
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((p) => join(ROOT, p)) : collectFiles();
  const { errors } = lintAll(files);
  for (const e of errors) {
    console.error(`\n${e.file}:`);
    for (const p of e.problems) console.error(`  ✗ ${p}`);
  }
  if (errors.length > 0) {
    console.error(
      `\n${errors.length} file(s) failed lint. Fix the issues above, then re-run: npm run lint`
    );
    process.exit(1);
  }
  console.log(`lint ok (${files.length} files)`);
}

if (process.argv[1] && process.argv[1].endsWith("lint.mjs")) {
  main();
}
