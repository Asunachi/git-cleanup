// End-to-end tests for the tap updater's release modes
// (homebrew-git-cleanup/update-formula.sh): the PR mode used by the
// git-cleanup release workflow (RELEASE_PR=1), the same-version sha
// re-verification, and the failure modes. Each test runs the real script
// against a throwaway bare remote with a fake `gh` shim on PATH, so the
// whole bump → branch → push → PR chain is exercised without touching
// GitHub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_SRC = join(root, "homebrew-git-cleanup", "update-formula.sh");
const FORMULA_SRC = join(root, "homebrew-git-cleanup", "Formula", "git-cleanup.rb");
const CUR = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const [MAJOR, MINOR, PATCH] = CUR.split(".").map(Number);
const NEXT = `${MAJOR}.${MINOR}.${PATCH + 1}`;

const posix = process.platform !== "win32" && spawnSync("bash", ["-c", "true"]).status === 0;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "gc-tap-pr-"));
  const remote = join(base, "origin.git");
  const work = join(base, "work");
  run("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
  run("git", ["clone", "-q", remote, work]);
  mkdirSync(join(work, "Formula"), { recursive: true });
  cpSync(FORMULA_SRC, join(work, "Formula", "git-cleanup.rb"));
  cpSync(SCRIPT_SRC, join(work, "update-formula.sh"));
  run("git", ["-C", work, "config", "user.name", "t"]);
  run("git", ["-C", work, "config", "user.email", "t@t"]);
  run("git", ["-C", work, "add", "-A"]);
  run("git", ["-C", work, "commit", "-q", "-m", "seed"]);
  run("git", ["-C", work, "push", "-q", "-u", "origin", "main"]);

  // Fixture tarball standing in for the npm artifact.
  const fixture = join(base, "fixture.tgz");
  writeFileSync(join(base, "fixture.src"), `fixture-${Math.random()}`);
  run("tar", ["czf", fixture, "-C", base, "fixture.src"]);

  // Fake gh: records every call; a marker file simulates an open PR.
  const shimDir = join(base, "shim");
  mkdirSync(shimDir);
  const shim = join(shimDir, "gh");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "# Throwaway fake gh: records every call, simulates an open PR via a marker.",
      'echo "gh $*" >> "$GH_SHIM_LOG"',
      'case "${1:-}_${2:-}" in',
      '  "pr_create")',
      '    touch "$GH_SHIM_STATE"',
      '    echo "https://github.com/Asunachi/homebrew-git-cleanup/pull/1"',
      "    ;;",
      '  "pr_view")',
      '    [ -f "$GH_SHIM_STATE" ]',
      "    ;;",
      '  *)',
      '    echo "fake gh: unexpected call: $*" >&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n")
  );
  chmodSync(shim, 0o755);

  return { base, work, fixture, shimDir };
}

function runUpdater(work, env) {
  return spawnSync("bash", ["./update-formula.sh"], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function prEnv(base, extra = {}) {
  return {
    RELEASE_TAG: `v${NEXT}`,
    RELEASE_PR: "1",
    // Mirror the release workflow: the tarball is hashed from a local source
    // (the release tree, standing in here for a file fixture) while the
    // formula's url stays pointed at the registry artifact.
    TARBALL_URL: `file://${base.fixture}`,
    WRITE_URL: `https://registry.npmjs.org/@maliqkara/gitcleanup/-/gitcleanup-${NEXT}.tgz`,
    TAP_REPO: "Asunachi/homebrew-git-cleanup",
    GH_TOKEN: "dummy",
    GH_SHIM_LOG: join(base.base, "gh.log"),
    GH_SHIM_STATE: join(base.base, "pr.state"),
    PATH: `${base.shimDir}:${process.env.PATH}`,
    ...extra,
  };
}

test("tap updater PR mode: bumps on a branch, pushes it, and opens a PR", { skip: !posix }, () => {
  const base = setup();
  try {
    const r = runUpdater(base.work, prEnv(base));
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // The release branch exists on the remote and carries the bump + the
    // sha of the tarball that was hashed.
    const ls = run("git", ["-C", base.work, "ls-remote", "origin", "refs/heads/release-v" + NEXT]);
    assert.match(ls.stdout, /refs\/heads\/release-v/);
    const branchFormula = run(
      "git",
      ["-C", base.work, "show", `origin/release-v${NEXT}:Formula/git-cleanup.rb`]
    ).stdout;
    assert.match(branchFormula, new RegExp(`gitcleanup-${NEXT}\\.tgz`));
    assert.ok(
      branchFormula.includes(`sha256 "${sha256File(base.fixture)}"`),
      "branch formula must pin the hashed tarball"
    );

    // Exactly one PR created, with the tap repo, base, and head wired up.
    const log = readFileSync(join(base.base, "gh.log"), "utf8");
    assert.match(
      log,
      new RegExp(`pr create --repo Asunachi/homebrew-git-cleanup --base main --head release-v${NEXT}`)
    );
    assert.equal((log.match(/pr create/g) ?? []).length, 1);
  } finally {
    rmSync(base.base, { recursive: true, force: true });
  }
});

test("tap updater PR mode: a re-run continues the branch and never duplicates the PR", { skip: !posix }, () => {
  const base = setup();
  try {
    const env = prEnv(base);
    const r1 = runUpdater(base.work, env);
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const logAfterRun1 = readFileSync(join(base.base, "gh.log"), "utf8");

    // Back to main (the script left the clone on the release branch) and
    // re-run the whole flow as a re-dispatch would. The re-run must land on
    // the existing release branch (clean switch, no fork), see the bump
    // already in place, and exit without touching gh.
    run("git", ["-C", base.work, "switch", "-q", "main"]);
    const r2 = runUpdater(base.work, env);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /nothing to do/);

    const log = readFileSync(join(base.base, "gh.log"), "utf8");
    assert.equal((log.match(/pr create/g) ?? []).length, 1, "exactly one PR created");
    // The log must not have grown during the re-run: it short-circuits on
    // "nothing to do" before any gh call.
    assert.equal(log, logAfterRun1, "re-run must not call gh");
  } finally {
    rmSync(base.base, { recursive: true, force: true });
  }
});

test("tap updater: same version with a matching sha is a no-op", { skip: !posix }, () => {
  const base = setup();
  try {
    // Point the formula's sha at the fixture so version AND sha match.
    const formula = readFileSync(join(base.work, "Formula", "git-cleanup.rb"), "utf8");
    writeFileSync(
      join(base.work, "Formula", "git-cleanup.rb"),
      formula.replace(/^  sha256 "[0-9a-f]{64}"/m, `  sha256 "${sha256File(base.fixture)}"`)
    );
    run("git", ["-C", base.work, "commit", "-q", "-am", "align sha"]);
    run("git", ["-C", base.work, "push", "-q", "origin", "main"]);

    const r = runUpdater(base.work, {
      RELEASE_TAG: `v${CUR}`,
      TARBALL_URL: `file://${base.fixture}`,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /nothing to do/);

    const head = run("git", ["-C", base.work, "log", "-1", "--format=%s"]).stdout.trim();
    assert.equal(head, "align sha", "a no-op must not commit");
  } finally {
    rmSync(base.base, { recursive: true, force: true });
  }
});

test("tap updater: same version with a stale sha gets re-pinned and pushed", { skip: !posix }, () => {
  const base = setup();
  try {
    const formula = readFileSync(join(base.work, "Formula", "git-cleanup.rb"), "utf8");
    writeFileSync(
      join(base.work, "Formula", "git-cleanup.rb"),
      formula.replace(/^  sha256 "[0-9a-f]{64}"/m, `  sha256 "${"0".repeat(64)}"`)
    );
    run("git", ["-C", base.work, "commit", "-q", "-am", "stale sha"]);
    run("git", ["-C", base.work, "push", "-q", "origin", "main"]);

    const r = runUpdater(base.work, {
      RELEASE_TAG: `v${CUR}`,
      TARBALL_URL: `file://${base.fixture}`,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /re-pinning/);

    const after = run(
      "git",
      ["-C", base.work, "show", "origin/main:Formula/git-cleanup.rb"]
    ).stdout;
    assert.ok(
      after.includes(`sha256 "${sha256File(base.fixture)}"`),
      "the stale sha must be re-pinned to the hashed tarball"
    );
    const head = run("git", ["-C", base.work, "log", "origin/main", "-1", "--format=%s"]).stdout.trim();
    assert.equal(head, `git-cleanup ${CUR}`);
  } finally {
    rmSync(base.base, { recursive: true, force: true });
  }
});

test("tap updater PR mode without the GitHub CLI fails loudly before touching the remote", { skip: !posix }, (t) => {
  const hasGh = spawnSync("bash", ["-c", "command -v gh >/dev/null 2>&1"]).status === 0;
  if (hasGh) {
    t.skip("gh is installed — the missing-gh path cannot be exercised here");
    return;
  }
  const base = setup();
  try {
    const r = runUpdater(base.work, {
      RELEASE_TAG: `v${NEXT}`,
      RELEASE_PR: "1",
      TARBALL_URL: `file://${base.fixture}`,
      TAP_REPO: "Asunachi/homebrew-git-cleanup",
      GH_TOKEN: "dummy",
      // Deliberately no shim on PATH.
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires the GitHub CLI/);
    const ls = run("git", ["-C", base.work, "ls-remote", "origin"]);
    assert.doesNotMatch(ls.stdout, /release-v/, "nothing may be pushed");
  } finally {
    rmSync(base.base, { recursive: true, force: true });
  }
});
