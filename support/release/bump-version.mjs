#!/usr/bin/env node
// The version-bump engine behind .github/workflows/release.yml. Zero
// dependencies on purpose: reads package.json, computes the next semver
// version, refuses to reuse an existing tag, and re-seeds the Homebrew tap
// scaffold (homebrew-git-cleanup/Formula/git-cleanup.rb) with the new
// version and the sha256 of the tarball this tree will publish.
//
// npm pack is deterministic for a fixed Node version, and the registry
// serves byte-identical artifacts to the pack that uploads them — so
// hashing the local pack is faithful to what `npm publish` will upload
// WHEN BOTH RUN ON THE SAME NODE. Pack output varies across Node versions
// (zlib differences — Node 20 vs 26 produce different digests for the same
// tree), so this script's sha is only trustworthy when the publish machine
// matches the packing Node. The tap updater's daily re-verification
// against the real registry tarball is the ground truth regardless.
//
// Usage (run from the repository root):
//   node support/release/bump-version.mjs [patch|minor|major|exact=X.Y.Z] [--dry-run]
//
// Prints the new version on stdout (the workflow captures it). With
// --dry-run it prints the version and changes nothing.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// Spawning npm on Windows is a trap: the bare name ENOENTs (CreateProcess
// does not resolve PATHEXT) and .cmd files refuse to spawn without a shell
// (EINVAL), where shell-quoted args are their own quoting hazard. When we
// run under `npm test`, npm tells us its own CLI JS via npm_execpath — spawn
// that with node directly, no .cmd, no shell. Elsewhere (the release
// workflow, ubuntu) plain `npm` works.
const npmExec = process.env.npm_execpath;
const packCmd = npmExec ? process.execPath : "npm";
const packArgs = npmExec
  ? [npmExec, "pack", "--pack-destination"]
  : ["pack", "--pack-destination"];
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spawn env for the nested `npm pack`: strip every npm_config_* variable the
 * outer npm injects. `npm publish --dry-run` leaks npm_config_dry_run=true,
 * which makes the nested pack dry-run too — exit 0, tarball name printed,
 * nothing written (verified live) — so the rehearsal fails its own suite and
 * the pin silently never exists. The nested npm must see only its CLI args
 * and .npmrc, whatever the outer command was.
 */
function packEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_config_")) delete env[key];
  }
  return env;
}

const PKG_PATH = join(process.cwd(), "package.json");
const FORMULA_PATH = join(
  process.cwd(),
  "homebrew-git-cleanup",
  "Formula",
  "git-cleanup.rb"
);

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const arg = args.find((a) => !a.startsWith("--")) ?? "patch";

let pkg;
try {
  pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
} catch {
  fail(`cannot read package.json at ${PKG_PATH} — run me from the repository root`);
}

const current = pkg.version;
const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!parts) fail(`package.json version '${current}' is not X.Y.Z`);

let next;
if (arg.startsWith("exact=")) {
  next = arg.slice("exact=".length);
  if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`exact version '${next}' is not X.Y.Z`);
} else {
  const [, major, minor, patch] = parts.map(Number);
  if (arg === "patch") next = `${major}.${minor}.${patch + 1}`;
  else if (arg === "minor") next = `${major}.${minor + 1}.0`;
  else if (arg === "major") next = `${major + 1}.0.0`;
  else fail(`unknown bump '${arg}' (expected patch, minor, major, or exact=X.Y.Z)`);
}

// Safety: never reuse a version that already has a tag. A release that
// reuses a tag silently rewrites history and confuses every consumer.
const tag = `v${next}`;
const tagExists =
  spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    encoding: "utf8",
  }).status === 0;
if (tagExists) {
  fail(`tag ${tag} already exists — pick a different version (exact=...)`);
}

if (dryRun) {
  console.log(next);
  console.error(
    `DRY RUN: would bump ${current} -> ${next} in package.json and re-seed ` +
      `the tap formula (version + sha256 from npm pack); the workflow would ` +
      `commit, tag ${tag}, push, publish the GitHub Release, and file the tap PR.`
  );
  process.exit(0);
}

// --- 1. package.json -------------------------------------------------------
pkg.version = next;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

// --- 2. pack the exact tree and hash the tarball --------------------------
const tmp = mkdtempSync(join(tmpdir(), "gc-bump-"));
try {
  const pack = spawnSync(packCmd, [...packArgs, tmp], {
    encoding: "utf8",
    env: packEnv(),
  });
  if (pack.status !== 0) {
    fail(`npm pack failed:\n${pack.stderr || pack.stdout}`);
  }
  const tarball = pack.stdout.trim().split("\n").pop();
  const sha = createHash("sha256")
    .update(readFileSync(join(tmp, tarball)))
    .digest("hex");

  // --- 3. re-seed the tap formula (validated on a copy, swapped only after)
  let formula;
  try {
    formula = readFileSync(FORMULA_PATH, "utf8");
  } catch {
    fail(`cannot read the tap formula at ${FORMULA_PATH}`);
  }
  const patched = formula
    .replace(
      /^  url "([^"]*gitcleanup-)[0-9][0-9.]*(\.tgz)"$/m,
      `  url "$1${next}$2"`
    )
    .replace(/^  sha256 "[0-9a-f]{64}"$/m, `  sha256 "${sha}"`);

  const urlLine = patched.match(/^  url "([^"]+)"/m)?.[1];
  if (!urlLine || !urlLine.includes(`gitcleanup-${next}.tgz`)) {
    fail("formula patch produced no 'gitcleanup-<version>.tgz' url line");
  }
  if ((patched.match(/^  url "/gm) ?? []).length !== 1) {
    fail("formula must have exactly one url line after patching");
  }
  if ((patched.match(/^  sha256 "/gm) ?? []).length !== 1) {
    fail("formula must have exactly one sha256 line after patching");
  }
  if (!patched.match(/^  sha256 "[0-9a-f]{64}"$/m)) {
    fail("formula sha256 must be exactly 64 hex characters");
  }
  writeFileSync(FORMULA_PATH, patched);
  console.log(next);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
