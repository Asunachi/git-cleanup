// Tests for support/release/bump-version.mjs — the version-bump engine
// behind .github/workflows/release.yml. The script must be dependency-free
// and deterministic: semver math, a tag-reuse guard, and a tap-formula
// re-seed whose sha256 equals the sha256 of `npm pack` on the same tree
// under the same Node version (pack output varies across Node versions —
// see CONTRIBUTING "Releasing" — which is why the tap's daily poll
// re-verifies against the real registry artifact).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUMP = join(root, "support", "release", "bump-version.mjs");
// Same spawn strategy as bump-version.mjs: under `npm test`, run npm's own
// CLI JS via node (npm.cmd refuses to spawn without a shell on Windows).
const npmExec = process.env.npm_execpath;
const packCmd = npmExec ? process.execPath : "npm";
const packArgs = npmExec ? [npmExec, "pack", "--pack-destination"] : ["pack", "--pack-destination"];
const ORIG_PKG = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ORIG_FORMULA = readFileSync(
  join(root, "homebrew-git-cleanup", "Formula", "git-cleanup.rb"),
  "utf8"
);
const CUR = ORIG_PKG.version;
const [CUR_MAJOR, CUR_MINOR, CUR_PATCH] = CUR.split(".").map(Number);
const NEXT_PATCH = `${CUR_MAJOR}.${CUR_MINOR}.${CUR_PATCH + 1}`;

/** Copy the repo (minus VCS/editor noise) into a throwaway dir. */
function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gc-release-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => {
      const last = src.split(sep).pop();
      return last !== ".git" && last !== "node_modules" && last !== ".freebuff";
    },
  });
  return dir;
}

test("bump-version: --dry-run prints the next patch version and changes nothing", () => {
  const dir = copyRepo();
  try {
    const r = spawnSync(process.execPath, [BUMP, "patch", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), NEXT_PATCH);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.version, CUR, "dry-run must not write package.json");
    const formula = readFileSync(
      join(dir, "homebrew-git-cleanup", "Formula", "git-cleanup.rb"),
      "utf8"
    );
    assert.equal(formula, ORIG_FORMULA, "dry-run must not touch the formula");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bump-version: minor/major/exact math and the default bump", () => {
  const dir = copyRepo();
  try {
    const run = (args) =>
      spawnSync(process.execPath, [BUMP, ...args, "--dry-run"], {
        cwd: dir,
        encoding: "utf8",
      });
    assert.equal(run([]).stdout.trim(), NEXT_PATCH, "default is patch");
    assert.equal(run(["minor"]).stdout.trim(), `${CUR_MAJOR}.${CUR_MINOR + 1}.0`);
    assert.equal(run(["major"]).stdout.trim(), `${CUR_MAJOR + 1}.0.0`);
    assert.equal(run(["exact=0.5.2"]).stdout.trim(), "0.5.2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bump-version: rejects unknown bumps and malformed exact versions", () => {
  const dir = copyRepo();
  try {
    const r1 = spawnSync(process.execPath, [BUMP, "next", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /unknown bump/);
    const r2 = spawnSync(process.execPath, [BUMP, "exact=abc", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /not X\.Y\.Z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bump-version: refuses to reuse an existing tag", () => {
  const dir = copyRepo();
  try {
    const g = (args) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    g(["init", "-q"]);
    g([
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    g(["tag", `v${NEXT_PATCH}`]);
    const r = spawnSync(process.execPath, [BUMP, "patch", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.version, CUR, "a refused bump must not write anything");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bump-version: real run bumps package.json and re-seeds the tap formula with the pack sha", () => {
  const dir = copyRepo();
  try {
    const r = spawnSync(process.execPath, [BUMP, "patch"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), NEXT_PATCH);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.version, NEXT_PATCH);

    const formula = readFileSync(
      join(dir, "homebrew-git-cleanup", "Formula", "git-cleanup.rb"),
      "utf8"
    );
    assert.match(formula, new RegExp(`gitcleanup-${NEXT_PATCH}\\.tgz`));
    assert.equal((formula.match(/^  url "/gm) ?? []).length, 1);
    assert.equal((formula.match(/^  sha256 "/gm) ?? []).length, 1);
    const pinned = formula.match(/^  sha256 "([0-9a-f]{64})"/m)[1];

    // The pinned sha must be the sha256 of the tarball this tree packs.
    const packDir = mkdtempSync(join(tmpdir(), "gc-pack-"));
    try {
      const pack = spawnSync(packCmd, [...packArgs, packDir], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(pack.status, 0, pack.stderr);
      const tarball = pack.stdout.trim().split("\n").pop();
      const sha = createHash("sha256")
        .update(readFileSync(join(packDir, tarball)))
        .digest("hex");
      assert.equal(sha, pinned, "formula sha256 must match the packed tarball");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
