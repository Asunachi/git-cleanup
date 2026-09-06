// Tests for the `doctor` diagnostic (src/doctor.mjs): git/gh presence,
// per-forge tokens, config validity (incl. forge.hosts claims), and remote
// detection — as data via runDoctor (with a stubbed gh spawn for
// determinism) and end-to-end through the real CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { runDoctor, printDoctor } from "../src/doctor.mjs";
import { main } from "../src/cli.mjs";

function sh(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

/** Fresh repo with one commit and an optional remote. */
function mkRepo(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "gc-doctor-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "f.txt"), "x");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "seed"]);
  if (remoteUrl) sh(dir, ["remote", "add", "origin", remoteUrl]);
  return dir;
}

/** spawnSync-compatible stub: gh answers from a table, git is real. */
function stubSpawn(ghOut) {
  return (cmd, args, opts) => {
    if (cmd === "gh") return ghOut;
    return spawnSync(cmd, args, opts);
  };
}

const NO_HOME = join(tmpdir(), "gc-doctor-no-home.json"); // never exists

const ALL_TOKENS = {
  GITHUB_TOKEN: "t",
  GITLAB_TOKEN: "t",
  BITBUCKET_TOKEN: "t",
  GITEA_TOKEN: "t",
};

const GH_OK = { status: 0, stdout: "gh version 2.50.0 (2024-08-19)\n", stderr: "" };
const GH_MISSING = { status: 1, stdout: "", stderr: "" };

test("doctor: healthy repo + all tokens + gh => ok, everything green", () => {
  const dir = mkRepo("git@github.com:owner/repo.git");
  try {
    const doc = runDoctor({
      cwd: dir,
      env: ALL_TOKENS,
      homeFile: NO_HOME,
      spawn: stubSpawn(GH_OK),
    });
    assert.equal(doc.ok, true);
    assert.equal(doc.counts.error, 0);
    assert.equal(doc.counts.warn, 0);
    assert.equal(doc.counts.ok, 9); // git + gh + config + repo + 4 tokens + 1 remote
    assert.match(doc.git.version, /^\d/);
    assert.equal(doc.gh.status, "ok");
    assert.match(doc.gh.version, /^2\.50\.0/);
    assert.equal(doc.config.status, "ok");
    assert.deepEqual(doc.config.sources, ["defaults"]);
    assert.equal(doc.repo.status, "ok");
    assert.equal(doc.repo.remotes.length, 1);
    assert.equal(doc.repo.remotes[0].forge, "github");
    assert.equal(doc.repo.remotes[0].claimed, false);
    assert.equal(doc.tokens.every((t) => t.set), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: missing tokens and missing gh are warnings, never failures", () => {
  const dir = mkRepo("git@github.com:owner/repo.git");
  try {
    const doc = runDoctor({ cwd: dir, env: {}, homeFile: NO_HOME, spawn: stubSpawn(GH_MISSING) });
    assert.equal(doc.ok, true, "warnings must not fail doctor");
    assert.equal(doc.counts.error, 0);
    assert.equal(doc.counts.warn, 6); // gh + 4 unset tokens + the github remote row
    assert.equal(doc.gh.status, "warn");
    assert.match(doc.gh.message, /CLI not installed/);
    const gitlab = doc.tokens.find((t) => t.forge === "gitlab");
    assert.match(gitlab.note, /GITLAB_TOKEN/);
    const github = doc.tokens.find((t) => t.forge === "github");
    assert.equal(github.set, false);
    // The per-remote line points at the missing token for its forge.
    assert.equal(doc.repo.remotes[0].status, "warn");
    assert.match(doc.repo.remotes[0].message, /no GITHUB_TOKEN set/);
    assert.match(printDoctor(doc), /6 warning/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: CI_JOB_TOKEN counts as the GitLab token", () => {
  const dir = mkRepo("git@gitlab.com:group/repo.git");
  try {
    const doc = runDoctor({
      cwd: dir,
      env: { CI_JOB_TOKEN: "job" },
      homeFile: NO_HOME,
      spawn: stubSpawn(GH_MISSING),
    });
    const gitlab = doc.tokens.find((t) => t.forge === "gitlab");
    assert.equal(gitlab.set, true);
    assert.match(gitlab.note, /CI_JOB_TOKEN fallback/);
    assert.equal(doc.repo.remotes[0].status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: a bitbucket-server remote reports against the shared BITBUCKET_TOKEN", () => {
  const dir = mkRepo("https://bitbucket.corp/scm/PROJ/repo.git");
  try {
    const bare = runDoctor({ cwd: dir, env: {}, homeFile: NO_HOME, spawn: stubSpawn(GH_MISSING) });
    const remote = bare.repo.remotes[0];
    assert.equal(remote.forge, "bitbucket-server");
    assert.equal(remote.status, "warn");
    // Server shares Cloud's token env var: the warning must name it.
    assert.match(remote.message, /no BITBUCKET_TOKEN set/);
    assert.match(remote.message, /bitbucket-server/);

    const withToken = runDoctor({
      cwd: dir,
      env: { BITBUCKET_TOKEN: "bt" },
      homeFile: NO_HOME,
      spawn: stubSpawn(GH_MISSING),
    });
    assert.equal(withToken.repo.remotes[0].status, "ok");
    assert.equal(withToken.counts.warn, 4); // gh + github/gitlab/gitea tokens
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: unrecognized remote warns with a forge.hosts hint; claiming fixes it", () => {
  const dir = mkRepo("git@git.internal:team/repo.git");
  try {
    const bare = runDoctor({ cwd: dir, env: ALL_TOKENS, homeFile: NO_HOME, spawn: stubSpawn(GH_OK) });
    assert.equal(bare.repo.remotes[0].forge, null);
    assert.equal(bare.repo.remotes[0].status, "warn");
    assert.match(bare.repo.remotes[0].message, /unrecognized host \(git\.internal\)/);
    assert.match(bare.repo.remotes[0].message, /forge\.hosts/);

    // Claim the host via the repo's own .gitcleanup.json.
    writeFileSync(
      join(dir, ".gitcleanup.json"),
      JSON.stringify({ forge: { hosts: { "git.internal": "gitea" } } })
    );
    const claimed = runDoctor({ cwd: dir, env: ALL_TOKENS, homeFile: NO_HOME, spawn: stubSpawn(GH_OK) });
    assert.equal(claimed.repo.remotes[0].forge, "gitea");
    assert.equal(claimed.repo.remotes[0].claimed, true);
    assert.equal(claimed.repo.remotes[0].status, "ok");
    assert.match(claimed.repo.remotes[0].message, /claimed via forge\.hosts/);
    assert.deepEqual(claimed.config.forgeHosts, { "git.internal": "gitea" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: a broken config is an error and fails the run", () => {
  const dir = mkRepo();
  try {
    writeFileSync(join(dir, ".gitcleanup.json"), "{ not json");
    const doc = runDoctor({ cwd: dir, env: ALL_TOKENS, homeFile: NO_HOME, spawn: stubSpawn(GH_OK) });
    assert.equal(doc.config.status, "error");
    assert.equal(doc.ok, false);
    assert.equal(doc.counts.error, 1);
    assert.match(printDoctor(doc), /✗ config/);

    // Unknown forge id in forge.hosts is also a loud config error.
    writeFileSync(
      join(dir, ".gitcleanup.json"),
      JSON.stringify({ forge: { hosts: { "git.internal": "sourcehut" } } })
    );
    const bad = runDoctor({ cwd: dir, env: ALL_TOKENS, homeFile: NO_HOME, spawn: stubSpawn(GH_OK) });
    assert.equal(bad.ok, false);
    assert.match(bad.config.message, /unknown forge "sourcehut"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: outside a git repo it still checks everything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-doctor-norepo-"));
  try {
    const doc = runDoctor({ cwd: dir, env: ALL_TOKENS, homeFile: NO_HOME, spawn: stubSpawn(GH_OK) });
    assert.equal(doc.repo.status, "warn");
    assert.match(doc.repo.message, /not inside a git repository/);
    assert.equal(doc.ok, true); // git + config still fine
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: repo without remotes notes that PR tracking has nothing to attach to", () => {
  const dir = mkRepo();
  try {
    const doc = runDoctor({ cwd: dir, env: ALL_TOKENS, homeFile: NO_HOME, spawn: stubSpawn(GH_OK) });
    assert.equal(doc.repo.status, "warn");
    assert.match(doc.repo.message, /no git remotes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CLI end-to-end ----------------------------------------------------------

const origHome = process.env.HOME;
function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "gc-doctor-home-"));
  process.env.HOME = home;
  return home;
}

test("CLI: doctor prints the report and exits 0 when nothing is broken", async () => {
  const dir = mkRepo("git@github.com:owner/repo.git");
  const home = isolatedHome();
  try {
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
      code = await main(["doctor", "--repo", dir]);
    } finally {
      process.stdout.write = origWrite;
      console.error = origErr;
    }
    const text = out.join("");
    assert.equal(code, 0, err.join("\n"));
    assert.match(text, /git-cleanup doctor/);
    assert.match(text, /✓ git \d/);
    assert.match(text, /github token GITHUB_TOKEN/);
    assert.match(text, /config: defaults/);
    assert.match(text, /origin → github \(github\.com\)/);
    assert.match(text, /\d+ ok · \d+ warning/);
    assert.equal(err.length, 0);
  } finally {
    process.env.HOME = origHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI: doctor --json emits the document; broken config exits 1", async () => {
  const dir = mkRepo();
  const home = isolatedHome();
  try {
    const run = async (args) => {
      const out = [];
      const origWrite = process.stdout.write;
      process.stdout.write = (chunk) => {
        out.push(String(chunk));
        return true;
      };
      let code;
      try {
        code = await main(args);
      } finally {
        process.stdout.write = origWrite;
      }
      return { code, out: out.join("") };
    };

    const good = await run(["doctor", "--repo", dir, "--json"]);
    assert.equal(good.code, 0);
    const doc = JSON.parse(good.out);
    assert.equal(typeof doc.ok, "boolean");
    assert.equal(doc.counts.error, 0);
    assert.equal(doc.git.status, "ok");

    writeFileSync(join(dir, ".gitcleanup.json"), "{ broken");
    const bad = await run(["doctor", "--repo", dir, "--json"]);
    assert.equal(bad.code, 1);
    const badDoc = JSON.parse(bad.out);
    assert.equal(badDoc.ok, false);
    assert.equal(badDoc.config.status, "error");
  } finally {
    process.env.HOME = origHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI: doctor accepts a single --repo; multiple is a loud error", async () => {
  const a = mkRepo();
  const b = mkRepo();
  const home = isolatedHome();
  try {
    const origErr = console.error;
    const err = [];
    console.error = (...x) => err.push(x.map(String).join(" "));
    let code;
    try {
      code = await main(["doctor", "--repo", a, "--repo", b]);
    } finally {
      console.error = origErr;
    }
    assert.equal(code, 1);
    assert.match(err.join("\n"), /doctor accepts a single --repo/);
  } finally {
    process.env.HOME = origHome;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
