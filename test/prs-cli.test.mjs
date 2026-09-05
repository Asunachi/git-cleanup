// End-to-end tests for `prs --json` and `prs --close`, driven through the
// real CLI entry (`main`) against real throwaway git repos with GitHub
// remotes. The only seams that are faked:
//   - the network: `fetch` is replaced by a stub serving the GitHub REST API
//   - the `gh` CLI: a directory named `gh` is prepended to PATH so spawning
//     it fails fast and locally (no real gh binary is ever consulted), which
//     forces the GITHUB_TOKEN REST fallback the same way an unauthenticated
//     machine would.
//
// This exercises the whole pipeline — parseArgs, config, analyzeRepo,
// provider detection, REST loading, the JSON document shape, and the close
// flow with its confirmations — exactly as a user hitting the binary would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

import { main } from "../src/cli.mjs";

const DAY = 24 * 60 * 60 * 1000;

function sh(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

/** Fresh repo with one commit on main and a GitHub remote (no network). */
function mkRepo(owner, repo) {
  const dir = mkdtempSync(join(tmpdir(), "gc-prs-test-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "f.txt"), "x");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "seed"]);
  sh(dir, ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
  return dir;
}

function httpRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/** GitHub REST shape for one PR. */
function ghPr({ number, title, headRef, updatedDaysAgo, draft = false, state = "open", merged = false, owner, repo }) {
  return {
    number,
    title,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    head: { ref: headRef },
    draft,
    state: merged ? "closed" : state,
    merged_at: merged ? new Date(Date.now() - (updatedDaysAgo - 1) * DAY).toISOString() : null,
    updated_at: new Date(Date.now() - updatedDaysAgo * DAY).toISOString(),
  };
}

const origFetch = globalThis.fetch;
const origConsoleLog = console.log;
const origConsoleError = console.error;
const origEnv = { ...process.env };

/** Directory named `gh` on PATH: spawning the CLI fails locally, forcing REST. */
function ghShimDir() {
  const dir = mkdtempSync(join(tmpdir(), "gc-ghshim-"));
  mkdirSync(join(dir, "gh"));
  return dir;
}

/** Swap in the stubbed fetch + captured console; returns a restore() fn. */
function stubRun(handler) {
  globalThis.fetch = handler;
  const out = [];
  const err = [];
  console.log = (...a) => out.push(a.map(String).join(" "));
  console.error = (...a) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore() {
      globalThis.fetch = origFetch;
      console.log = origConsoleLog;
      console.error = origConsoleError;
      process.env = origEnv;
    },
  };
}

/** Handler that serves per-repo PR lists and records close requests. */
function apiHandler(repos, log) {
  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = String(url);
    if (method === "PATCH" && u.includes("/pulls/")) {
      log.push({ kind: "close", url: u, body: JSON.parse(init.body) });
      return httpRes({});
    }
    if (method === "POST" && u.includes("/issues/") && u.includes("/comments")) {
      log.push({ kind: "comment", url: u, body: JSON.parse(init.body) });
      return httpRes({}, 201);
    }
    for (const [owner, repo, reply] of repos) {
      if (u.includes(`/repos/${owner}/${repo}/pulls`)) {
        if (typeof reply === "function") return reply();
        return httpRes(reply);
      }
    }
    return httpRes({ message: "not found" }, 404);
  };
}

/** Env + PATH so the run uses the gh shim, a token, and an isolated HOME. */
function runEnv() {
  const homeDir = mkdtempSync(join(tmpdir(), "gc-prs-home-"));
  const shimDir = ghShimDir();
  return {
    env: {
      ...process.env,
      HOME: homeDir,
      GITHUB_TOKEN: "test-token",
      GIT_CLEANUP_NO_COLOR: "1",
      PATH: `${shimDir}${delimiter}${process.env.PATH}`,
    },
    cleanup() {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

test.after(() => {
  globalThis.fetch = origFetch;
  console.log = origConsoleLog;
  console.error = origConsoleError;
  process.env = origEnv;
});

test("prs --json: one document, input order, stale lists + error entries", async () => {
  const one = mkRepo("acme", "one");
  const two = mkRepo("acme", "two");
  const three = mkRepo("acme", "three");
  const log = [];
  const requestLog = [];
  const handler = apiHandler(
    [
      [
        "acme",
        "one",
        [
          ghPr({ owner: "acme", repo: "one", number: 412, title: "Widget parser", headRef: "feature/parser", updatedDaysAgo: 61 }),
          ghPr({ owner: "acme", repo: "one", number: 7, title: "Draft refactor", headRef: "feature/draft", updatedDaysAgo: 33, draft: true }),
          ghPr({ owner: "acme", repo: "one", number: 8, title: "Fresh work", headRef: "feature/fresh", updatedDaysAgo: 5 }),
          ghPr({ owner: "acme", repo: "one", number: 1, title: "Old merged", headRef: "feature/merged", updatedDaysAgo: 90, merged: true }),
        ],
      ],
      [
        "acme",
        "two",
        [ghPr({ owner: "acme", repo: "two", number: 3, title: "Only fresh", headRef: "feature/x", updatedDaysAgo: 2 })],
      ],
      [
        "acme",
        "three",
        () => httpRes({ message: "boom" }, 500),
      ],
    ],
    requestLog
  );

  const env = runEnv();
  try {
    process.env = env.env;
    const run = stubRun(handler);
    let code;
    try {
      code = await main(["prs", "--json", "--repo", one, "--repo", two, "--repo", three]);
    } finally {
      run.restore();
    }

    assert.equal(code, 0, run.err.join("\n"));
    const doc = JSON.parse(run.out.join("\n"));
    assert.ok(Array.isArray(doc));
    assert.equal(doc.length, 3, run.out.join("\n"));
    // Input order is preserved.
    assert.equal(doc[0].repo.repo, "one");
    assert.equal(doc[1].repo.repo, "two");
    assert.equal(doc[2].repo.repo, "three");

    // Repo one: two stale open PRs (merged and fresh ones excluded),
    // newest-first, with the full per-PR shape.
    assert.equal(doc[0].staleAfterDays, 30);
    assert.deepEqual(
      doc[0].prs.map((p) => p.number),
      [412, 7]
    );
    assert.equal(doc[0].prs[0].state, "open");
    assert.equal(doc[0].prs[0].isDraft, false);
    assert.equal(doc[0].prs[0].title, "Widget parser");
    assert.equal(doc[0].prs[0].url, "https://github.com/acme/one/pull/412");
    assert.ok(doc[0].prs[0].ageDays >= 30);
    assert.equal(doc[0].prs[1].isDraft, true);
    assert.ok(doc[0].prs[0].ageDays >= doc[0].prs[1].ageDays);

    // Repo two: usable backend but nothing stale -> prs: [] (still one doc).
    assert.deepEqual(doc[1].prs, []);

    // Repo three: API failure -> error entry instead of a stale list.
    assert.match(doc[2].error, /GitHub API 500/);
    assert.equal(doc[2].prs, undefined);

    // No close requests were made by a plain listing.
    assert.deepEqual(requestLog, []);
  } finally {
    env.cleanup();
    for (const d of [one, two, three]) rmSync(d, { recursive: true, force: true });
  }
});

test("prs --close --yes --json: closes stale PRs via PATCH + comment, exit 0", async () => {
  const repo = mkRepo("acme", "closer");
  const requestLog = [];
  const handler = apiHandler(
    [
      [
        "acme",
        "closer",
        [
          ghPr({ owner: "acme", repo: "closer", number: 412, title: "Stale one", headRef: "feature/a", updatedDaysAgo: 61 }),
          ghPr({ owner: "acme", repo: "closer", number: 7, title: "Stale two", headRef: "feature/b", updatedDaysAgo: 45 }),
          ghPr({ owner: "acme", repo: "closer", number: 9, title: "Fresh", headRef: "feature/c", updatedDaysAgo: 3 }),
        ],
      ],
    ],
    requestLog
  );

  const env = runEnv();
  try {
    process.env = env.env;
    const run = stubRun(handler);
    let code;
    try {
      code = await main(["prs", "--close", "--yes", "--json", "--repo", repo]);
    } finally {
      run.restore();
    }

    assert.equal(code, 0, run.err.join("\n"));

    // The JSON document still precedes the close flow: stdout starts with
    // the doc, then the human close lines follow (expected --json --close
    // behavior, so only the first output chunk is the document).
    const doc = JSON.parse(run.out[0]);
    assert.equal(doc.length, 1);
    assert.deepEqual(doc[0].prs.map((p) => p.number), [412, 7]);

    // Both stale PRs were closed with the default comment; the fresh one wasn't.
    const closes = requestLog.filter((r) => r.kind === "close");
    assert.deepEqual(
      closes.map((r) => r.url.replace(/^.*\/pulls\//, "")),
      ["412", "7"]
    );
    for (const r of closes) {
      assert.deepEqual(r.body, { state: "closed" });
    }
    const comments = requestLog.filter((r) => r.kind === "comment");
    assert.equal(comments.length, 2);
    for (const r of comments) {
      assert.match(r.body.body, /automatically flagged as stale/);
      assert.ok(r.url.includes("/issues/"));
    }
    assert.match(run.out.join("\n"), /2 stale PRs closed/);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});