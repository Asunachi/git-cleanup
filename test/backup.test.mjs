// Tests for the `backup` command (src/backup.mjs): listing the git-bundle
// backups prune writes before -D deletions, and restoring branches from
// them — including the full prune -> list -> restore lifecycle through the
// real CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { listBackupFiles, restoreBackup } from "../src/backup.mjs";
import { main } from "../src/cli.mjs";

const DAY = 24 * 60 * 60 * 1000;

function sh(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gc-backup-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "f.txt"), "x");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

/** A real backup bundle in the repo's default backup dir, prune-style name. */
function makeBundle(repoDir, { ref = "refs/heads/feature/lost", tag = "force" } = {}) {
  const dir = join(repoDir, ".git", "git-cleanup-backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `backup-${stamp}-${tag}.bundle`);
  sh(repoDir, ["bundle", "create", file, ref]);
  return file;
}

/** Run main() with stdout+stderr captured; HOME isolated so no real config leaks. */
async function runCli(args, { home } = {}) {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  if (home) process.env.HOME = home;
  const out = [];
  const err = [];
  const origWrite = process.stdout.write;
  const origErr = console.error;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  console.error = (...a) => err.push(a.map(String).join(" "));
  let code;
  try {
    code = await main(args);
  } finally {
    process.stdout.write = origWrite;
    console.error = origErr;
    process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
  return { code, out: out.join(""), err: err.join("\n") };
}

function newHome() {
  return mkdtempSync(join(tmpdir(), "gc-backup-home-"));
}

test("backup list: no backups yet reports an empty list, exit 0", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    const doc = listBackupFiles(dir, { backup: { enabled: true, dir: null, retainDays: 0 } });
    assert.equal(doc.backups.length, 0);
    assert.ok(doc.dir.endsWith(join(".git", "git-cleanup-backups")));
    const r = await runCli(["backup", "list", "--repo", dir], { home });
    assert.equal(r.code, 0);
    assert.match(r.out, /no backups yet/);
    const j = await runCli(["backup", "list", "--repo", dir, "--json"], { home });
    assert.equal(j.code, 0);
    assert.deepEqual(JSON.parse(j.out).backups, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup list: shows a real bundle with its branches and size", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    sh(dir, ["checkout", "-qb", "feature/lost"]);
    writeFileSync(join(dir, "lost.txt"), "y");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "lost work"]);
    sh(dir, ["checkout", "-q", "main"]);
    const file = makeBundle(dir);
    const name = file.split("/").pop();

    const doc = listBackupFiles(dir, { backup: { enabled: true, dir: null, retainDays: 0 } });
    assert.equal(doc.backups.length, 1);
    assert.equal(doc.backups[0].name, name);
    assert.deepEqual(doc.backups[0].branches, ["refs/heads/feature/lost"]);
    assert.ok(doc.backups[0].sizeBytes > 0);
    assert.ok(!Number.isNaN(Date.parse(doc.backups[0].created)));
    assert.equal(doc.backups[0].wouldSweep, false);

    const r = await runCli(["backup", "list", "--repo", dir], { home });
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(name));
    assert.match(r.out, /feature\/lost/);
    assert.match(r.out, /restore: git-cleanup backup restore/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup list: a bundle past backup.retainDays is flagged as would-sweep", () => {
  const dir = mkRepo();
  try {
    sh(dir, ["checkout", "-qb", "feature/lost"]);
    writeFileSync(join(dir, "lost.txt"), "y");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "lost work"]);
    sh(dir, ["checkout", "-q", "main"]);
    const file = makeBundle(dir);
    const old = new Date(Date.now() - 3 * DAY);
    utimesSync(file, old, old);

    const cfg = { backup: { enabled: true, dir: null, retainDays: 1 } };
    const doc = listBackupFiles(dir, cfg);
    assert.equal(doc.backups[0].wouldSweep, true);
    // Fresh bundles are not flagged even with a retention configured.
    utimesSync(file, new Date(), new Date());
    assert.equal(listBackupFiles(dir, cfg).backups[0].wouldSweep, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup restore: refuses non-interactively without --yes, nothing restored", async () => {
  const dir = mkRepo();
  try {
    sh(dir, ["checkout", "-qb", "feature/lost"]);
    writeFileSync(join(dir, "lost.txt"), "y");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "lost work"]);
    const sha = sh(dir, ["rev-parse", "feature/lost"]).stdout.trim();
    const file = makeBundle(dir); // bundle FIRST: the ref must still exist
    sh(dir, ["checkout", "-q", "main"]);
    sh(dir, ["branch", "-D", "feature/lost"]);

    const cfg = { backup: { enabled: true, dir: null, retainDays: 0 } };
    await assert.rejects(
      () => restoreBackup({ cwd: dir, cfg, name: file.split("/").pop() }),
      /--yes.*nothing was restored/
    );
    assert.equal(
      sh(dir, ["rev-parse", "--verify", "--quiet", "feature/lost"], { allowFail: true }).status,
      1
    );
    assert.equal(
      sh(dir, ["rev-parse", "--verify", "--quiet", "refs/heads/feature/lost"], { allowFail: true })
        .status,
      1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup restore: fetches missing branches back at their original commit", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    sh(dir, ["checkout", "-qb", "feature/lost"]);
    writeFileSync(join(dir, "lost.txt"), "y");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "lost work"]);
    const sha = sh(dir, ["rev-parse", "feature/lost"]).stdout.trim();
    const file = makeBundle(dir); // bundle FIRST: the ref must still exist
    sh(dir, ["checkout", "-q", "main"]);
    sh(dir, ["branch", "-D", "feature/lost"]);
    const name = file.split("/").pop();

    const r = await runCli(["backup", "restore", name, "--repo", dir, "--yes"], { home });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ restored refs\/heads\/feature\/lost/);
    assert.match(r.out, /restored 1 branch/);
    assert.equal(sh(dir, ["rev-parse", "feature/lost"]).stdout.trim(), sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup restore: branches that already exist are skipped, never clobbered", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    sh(dir, ["checkout", "-qb", "feature/lost"]);
    writeFileSync(join(dir, "lost.txt"), "y");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "lost work"]);
    const sha = sh(dir, ["rev-parse", "feature/lost"]).stdout.trim();
    sh(dir, ["checkout", "-q", "main"]);
    const file = makeBundle(dir); // branch still exists locally

    const r = await runCli(["backup", "restore", file.split("/").pop(), "--repo", dir, "--yes"], {
      home,
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing to restore — every branch .* already exists/);
    assert.match(r.out, /already exists locally/);
    assert.equal(sh(dir, ["rev-parse", "feature/lost"]).stdout.trim(), sha, "branch untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup restore: unknown bundle names fail loudly and list what exists", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    sh(dir, ["checkout", "-qb", "feature/lost"]);
    writeFileSync(join(dir, "lost.txt"), "y");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "lost work"]);
    sh(dir, ["checkout", "-q", "main"]);
    const file = makeBundle(dir);
    const name = file.split("/").pop();

    const r = await runCli(["backup", "restore", "backup-nope.bundle", "--repo", dir, "--yes"], {
      home,
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /no backup named "backup-nope\.bundle"/);
    assert.match(r.err, new RegExp(name)); // lists the available one
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup restore: a directory or empty name is not a bundle path", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    // A directory passes existsSync — it must not fall through to the
    // confusing "cannot read bundle" path; it's not a bundle file at all.
    const r = await runCli(["backup", "restore", dir, "--repo", dir, "--yes"], {
      home,
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /no backup named/);
    assert.doesNotMatch(r.err, /cannot read bundle/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup restore: a bundle holding remote-tracking refs restores them too", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    // Craft a bundle containing a refs/remotes/origin/x ref, then restore it
    // into a repo that lacks it.
    sh(dir, ["update-ref", "refs/remotes/origin/feature/gone", "HEAD"]);
    const file = makeBundle(dir, { ref: "refs/remotes/origin/feature/gone", tag: "remote" });
    sh(dir, ["update-ref", "-d", "refs/remotes/origin/feature/gone"]);

    const r = await runCli(
      ["backup", "restore", file.split("/").pop(), "--repo", dir, "--yes"],
      { home }
    );
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ restored refs\/remotes\/origin\/feature\/gone/);
    assert.equal(
      sh(dir, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/feature/gone"]).status,
      0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup: subcommand validation is loud", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    const none = await runCli(["backup"], { home });
    assert.equal(none.code, 1);
    assert.match(none.err, /backup needs a subcommand: list or restore/);

    const noBundle = await runCli(["backup", "restore", "--repo", dir], { home });
    assert.equal(noBundle.code, 1);
    assert.match(none.err, /backup needs a subcommand/);
    assert.match(noBundle.err, /backup restore needs one argument/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("lifecycle: prune backs up a force-deleted branch, list shows it, restore brings it back", async () => {
  const dir = mkRepo();
  const home = newHome();
  try {
    sh(dir, ["checkout", "-qb", "tmp/scratch"]);
    writeFileSync(join(dir, "scratch.txt"), "z");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "scratch work"]);
    const sha = sh(dir, ["rev-parse", "tmp/scratch"]).stdout.trim();
    sh(dir, ["checkout", "-q", "main"]);
    // Write the force rule AFTER the branch work: an `add .` on the branch
    // would otherwise commit it, and checking out main would delete it.
    // --config is explicit: the main flow discovers config from the process
    // cwd, so the fixture's own .gitcleanup.json would otherwise be missed.
    writeFileSync(
      join(dir, ".gitcleanup.json"),
      JSON.stringify({ rules: [{ match: "tmp/*", mode: "any", minAgeDays: 0 }] })
    );
    const pruned = await runCli(
      ["prune", "--repo", dir, "--yes", "--config", join(dir, ".gitcleanup.json")],
      { home }
    );
    assert.equal(pruned.code, 0, pruned.out);
    assert.match(pruned.out, /backed up →/);
    assert.match(pruned.out, /deleted 1 local branch/);
    assert.equal(
      sh(dir, ["rev-parse", "--verify", "--quiet", "tmp/scratch"], { allowFail: true }).status,
      1
    );

    const listed = await runCli(["backup", "list", "--repo", dir], { home });
    assert.equal(listed.code, 0, listed.out);
    const name = /backup-[^\s]+-force\.bundle/.exec(listed.out)?.[0];
    assert.ok(name, `force bundle listed: ${listed.out}`);
    assert.match(listed.out, /tmp\/scratch/);

    const restored = await runCli(["backup", "restore", name, "--repo", dir, "--yes"], { home });
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, /✓ restored refs\/heads\/tmp\/scratch/);
    assert.equal(sh(dir, ["rev-parse", "tmp/scratch"]).stdout.trim(), sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
