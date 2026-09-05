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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

import { main } from "../src/cli.mjs";
import { closePR, PRBackendError } from "../src/providers/github.mjs";

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

function httpRes(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
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

/**
 * A working fake `gh` CLI on PATH: `pr list` cats $FAKE_GH_JSON, `pr close`
 * appends "close:<number>" to $FAKE_GH_LOG. POSIX-only (the shim is a shell
 * script; spawning .cmd files requires a shell, which the CLI never uses).
 */
function fakeGhEnv(prsJson) {
  const dir = mkdtempSync(join(tmpdir(), "gc-fakegh-"));
  const homeDir = mkdtempSync(join(tmpdir(), "gc-fakegh-home-"));
  const jsonFile = join(dir, "prs.json");
  const logFile = join(dir, "close.log");
  writeFileSync(jsonFile, JSON.stringify(prsJson));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then cat "$FAKE_GH_JSON"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "close" ]; then echo "close:$3" >> "$FAKE_GH_LOG"; exit 0; fi',
      "exit 1",
      "",
    ].join("\n")
  );
  chmodSync(join(dir, "gh"), 0o755);
  return {
    env: {
      ...process.env,
      HOME: homeDir,
      GIT_CLEANUP_NO_COLOR: "1",
      FAKE_GH_JSON: jsonFile,
      FAKE_GH_LOG: logFile,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
    },
    logFile,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
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

// ---- PR pagination truncation detection ------------------------------------
// A repo with more PRs than the fetch cap must not silently judge branches
// against an incomplete PR picture: scan --json reports pr.truncated and the
// human report says so out loud.

test("scan --json reports truncated when the REST API keeps paginating past the cap", async () => {
  const repo = mkRepo("acme", "huge");
  const seen = [];
  const handler = async (url) => {
    const u = String(url);
    const page = Number(new URL(u).searchParams.get("page") ?? "1");
    seen.push(page);
    if (page <= 20) {
      const items = Array.from({ length: 100 }, (_, i) =>
        ghPr({
          owner: "acme",
          repo: "huge",
          number: (page - 1) * 100 + i + 1,
          title: `pr ${page}-${i}`,
          headRef: `branch-${page}-${i}`,
          updatedDaysAgo: 90,
        })
      );
      return httpRes(items, 200, {
        link: `<https://api.github.com/repos/acme/huge/pulls?page=${page + 1}>; rel="next"`,
      });
    }
    return httpRes({ message: "not found" }, 404);
  };

  const env = runEnv();
  try {
    process.env = env.env;
    const run = stubRun(handler);
    let code;
    try {
      code = await main(["scan", "--json", "--repo", repo]);
    } finally {
      run.restore();
    }
    assert.equal(code, 0, run.err.join("\n"));
    const doc = JSON.parse(run.out.join("\n"));
    assert.equal(doc.repos[0].pr.source, "rest");
    assert.equal(doc.repos[0].pr.truncated, true);
    // Stopped at the cap (20 pages), never fetched past it.
    assert.equal(seen.length, 20);
    assert.equal(seen[seen.length - 1], 20);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("scan flags truncated PR data in the human report too", async () => {
  const repo = mkRepo("acme", "huge-human");
  const handler = async (url) => {
    const u = String(url);
    const page = Number(new URL(u).searchParams.get("page") ?? "1");
    if (page <= 20) {
      return httpRes(
        Array.from({ length: 100 }, (_, i) =>
          ghPr({
            owner: "acme",
            repo: "huge-human",
            number: (page - 1) * 100 + i + 1,
            title: `pr ${i}`,
            headRef: `branch-${i}`,
            updatedDaysAgo: 90,
          })
        ),
        200,
        { link: `<https://api.github.com/repos/acme/huge-human/pulls?page=${page + 1}>; rel="next"` }
      );
    }
    return httpRes({ message: "not found" }, 404);
  };

  const env = runEnv();
  try {
    process.env = env.env;
    const run = stubRun(handler);
    let code;
    try {
      code = await main(["scan", "--repo", repo]);
    } finally {
      run.restore();
    }
    assert.equal(code, 0, run.err.join("\n"));
    assert.match(run.out.join("\n"), /PR data truncated/);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("scan --json omits truncated when pagination ends naturally", async () => {
  const repo = mkRepo("acme", "small");
  const handler = async (url) => {
    const u = String(url);
    const page = Number(new URL(u).searchParams.get("page") ?? "1");
    if (page === 1) {
      // Full page but the API says there is no next page: not truncated.
      return httpRes(
        Array.from({ length: 100 }, (_, i) =>
          ghPr({
            owner: "acme",
            repo: "small",
            number: i + 1,
            title: `pr ${i}`,
            headRef: `branch-${i}`,
            updatedDaysAgo: 10,
          })
        ),
        200,
        {}
      );
    }
    return httpRes({ message: "not found" }, 404);
  };

  const env = runEnv();
  try {
    process.env = env.env;
    const run = stubRun(handler);
    let code;
    try {
      code = await main(["scan", "--json", "--repo", repo]);
    } finally {
      run.restore();
    }
    assert.equal(code, 0, run.err.join("\n"));
    const doc = JSON.parse(run.out.join("\n"));
    assert.equal(doc.repos[0].pr.truncated, undefined);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- the `gh` CLI path (POSIX only: the shim is a shell script) -------------

const onWindows = process.platform === "win32";

function ghPrShape(number, headRef, ageDays) {
  return {
    number,
    title: `pr ${number}`,
    state: "OPEN",
    isDraft: false,
    url: `https://github.com/acme/ghbig/pull/${number}`,
    headRefName: headRef,
    updatedAt: new Date(Date.now() - ageDays * DAY).toISOString(),
    mergedAt: null,
  };
}

test("scan --json reports truncated when gh returns more PRs than its cap", {
  skip: onWindows ? "fake gh shim is POSIX-only" : false,
}, async () => {
  const repo = mkRepo("acme", "ghbig");
  const env = fakeGhEnv(
    Array.from({ length: 501 }, (_, i) => ghPrShape(i + 1, `branch-${i}`, 100))
  );
  try {
    process.env = env.env;
    const run = stubRun(async () => {
      throw new Error("REST must not be consulted when gh works");
    });
    let code;
    try {
      code = await main(["scan", "--json", "--repo", repo]);
    } finally {
      run.restore();
    }
    assert.equal(code, 0, run.err.join("\n"));
    const doc = JSON.parse(run.out.join("\n"));
    assert.equal(doc.repos[0].pr.source, "gh");
    assert.equal(doc.repos[0].pr.truncated, true);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("scan --json is not truncated when gh returns exactly its cap", {
  skip: onWindows ? "fake gh shim is POSIX-only" : false,
}, async () => {
  const repo = mkRepo("acme", "ghcap");
  const env = fakeGhEnv(
    Array.from({ length: 500 }, (_, i) => ghPrShape(i + 1, `branch-${i}`, 100))
  );
  try {
    process.env = env.env;
    const run = stubRun(async () => {
      throw new Error("REST must not be consulted when gh works");
    });
    let code;
    try {
      code = await main(["scan", "--json", "--repo", repo]);
    } finally {
      run.restore();
    }
    assert.equal(code, 0, run.err.join("\n"));
    const doc = JSON.parse(run.out.join("\n"));
    assert.equal(doc.repos[0].pr.truncated, undefined);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prs --close --yes closes stale PRs through the real gh CLI path", {
  skip: onWindows ? "fake gh shim is POSIX-only" : false,
}, async () => {
  const repo = mkRepo("acme", "ghclose");
  const env = fakeGhEnv([
    { ...ghPrShape(5, "feature/a", 60), headRefName: "feature/a" },
    { ...ghPrShape(6, "feature/b", 3), headRefName: "feature/b" },
  ]);
  try {
    process.env = env.env;
    const run = stubRun(async () => {
      throw new Error("REST must not be consulted when gh works");
    });
    let code;
    try {
      code = await main(["prs", "--close", "--yes", "--repo", repo]);
    } finally {
      run.restore();
    }
    assert.equal(code, 0, run.err.join("\n"));
    assert.match(run.out.join("\n"), /✓ closed #5/);
    // The stale PR was handed to `gh pr close 5`; the fresh one was not.
    const log = readFileSync(env.logFile, "utf8").trim();
    assert.deepEqual(log.split("\n"), ["close:5"]);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a forge API that never responds times out instead of hanging the run", async () => {
  // Shell hooks and cron jobs must never hang on a dead network: the fetch
  // timeout (GIT_CLEANUP_FETCH_TIMEOUT_MS) turns a stuck API call into an
  // honest "PR lookup failed" error entry.
  const repo = mkRepo("acme", "slow");
  const env = runEnv();
  try {
    process.env = { ...env.env, GIT_CLEANUP_FETCH_TIMEOUT_MS: "100" };
    // A fetch that never settles — but, like the real one, honors the abort
    // signal the timeout helper passes (a signal-ignoring stub would hang
    // forever and prove nothing).
    const run = stubRun((url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal.reason ?? new Error("aborted"))
        );
      })
    );
    let code;
    try {
      code = await main(["scan", "--json", "--repo", repo]);
    } finally {
      run.restore();
    }
    assert.equal(code, 0, run.err.join("\n"));
    const doc = JSON.parse(run.out.join("\n"));
    assert.equal(doc.repos[0].pr.source, "none");
    assert.match(doc.repos[0].pr.error, /timeout|aborted/i);
  } finally {
    env.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("closing a PR fails loudly when the gh binary is unavailable", async () => {
  // Regression: closePR used to treat a missing gh binary as success
  // (!r.status on a spawn error is undefined), reporting "closed" for a PR
  // that is still open.
  const shim = ghShimDir();
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim}${delimiter}${oldPath}`;
    await assert.rejects(
      closePR({
        owner: "acme",
        repo: "x",
        source: "gh",
        pr: { number: 1 },
        comment: null,
      }),
      PRBackendError
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim, { recursive: true, force: true });
  }
});
