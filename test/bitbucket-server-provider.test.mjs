// Bitbucket Server (Data Center) provider tests: remote parsing across the
// /scm/ and ssh-port URL shapes, PR loading via a stubbed Server REST API
// (isLastPage/nextPageStart pagination, epoch-ms dates, fromRef branches),
// truncation at the cap, degradation without a token, end-to-end dispatch,
// and closing via the versioned decline endpoint. The HTTP layer is
// replaced with a fake `fetch`; remote detection runs against real
// throwaway git repos.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { bitbucketServerProvider } from "../src/providers/bitbucket-server.mjs";
import { closePR, detectForge, loadPRs, providers } from "../src/forge.mjs";

const DAY = 24 * 60 * 60 * 1000;
const API = "https://bitbucket.corp/rest/api/1.0";

function sh(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

/** Fresh repo with one commit and an optional remote URL. */
function mkRepo(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "gc-bitbucket-server-test-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "f.txt"), "x");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "seed"]);
  if (remoteUrl) sh(dir, ["remote", "add", "origin", remoteUrl]);
  return dir;
}

function httpRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/** Bitbucket Server REST shape for one pull request. */
function bsPr({ id, version = 1, title, headRef, state, updatedDaysAgo, closedDaysAgo = null, host = "bitbucket.corp", now = Date.now() }) {
  return {
    id,
    version,
    title,
    state, // "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED"
    open: state === "OPEN",
    links: { self: [{ href: `https://${host}/projects/PROJ/repos/repo/pull-requests/${id}` }] },
    fromRef: { id: `refs/heads/${headRef}`, displayId: headRef },
    updatedDate: now - updatedDaysAgo * DAY,
    closedDate: closedDaysAgo === null ? null : now - closedDaysAgo * DAY,
  };
}

const origFetch = globalThis.fetch;

test("parseBitbucketServerRemote handles scm, ssh-port, scp-like and claims", () => {
  const p = bitbucketServerProvider.parseRemote;
  assert.deepEqual(p("https://bitbucket.corp/scm/PROJ/repo.git"), {
    owner: "PROJ",
    repo: "repo",
    host: "bitbucket.corp",
    apiBase: API,
  });
  // Without the /scm/ prefix, and without the .git suffix.
  assert.deepEqual(p("https://bitbucket.corp/PROJ/repo"), {
    owner: "PROJ",
    repo: "repo",
    host: "bitbucket.corp",
    apiBase: API,
  });
  // ssh:// with the conventional 7999 port and an /scm/ path.
  assert.deepEqual(p("ssh://git@bitbucket.corp:7999/scm/PROJ/repo.git"), {
    owner: "PROJ",
    repo: "repo",
    host: "bitbucket.corp",
    apiBase: API,
  });
  // scp-like host:key/repo, plus userinfo on https.
  assert.deepEqual(p("git@bitbucket.corp:PROJ/repo.git").owner, "PROJ");
  assert.deepEqual(p("https://user@bitbucket.example.org/scm/team/repo.git").host, "bitbucket.example.org");
  // A forge.hosts claim accepts arbitrary domains; without it they are not claimed.
  assert.equal(p("git@stash.internal:PROJ/repo.git"), null);
  assert.equal(p("git@stash.internal:PROJ/repo.git", { "stash.internal": "bitbucket-server" })?.owner, "PROJ");
  // bitbucket.org is Cloud; nested groups do not exist on Server; other
  // forges are never claimed.
  assert.equal(p("https://bitbucket.org/ws/repo.git"), null);
  assert.equal(p("https://bitbucket.corp/scm/group/sub/repo.git"), null); // no nested groups
  assert.equal(p("https://github.com/owner/repo.git"), null);
  assert.equal(p("https://gitlab.com/o/r.git"), null);
  assert.equal(p("https://example.com/o/r.git"), null);
  assert.equal(p(""), null);
  assert.equal(p(null), null);
});

test("bitbucket-server is registered; bitbucket-ish hosts route to it, bitbucket.org stays Cloud", () => {
  assert.ok(providers["bitbucket-server"], "bitbucket-server provider registered");
  assert.equal(providers["bitbucket-server"].id, "bitbucket-server");
  // Hostnames containing "bitbucket" (other than bitbucket.org) are assumed Server.
  assert.equal(detectForge("https://bitbucket.corp/scm/PROJ/repo.git"), "bitbucket-server");
  assert.equal(detectForge("git@bitbucket.example.org:PROJ/repo.git"), "bitbucket-server");
  assert.equal(detectForge("https://bitbucket.org/o/r"), "bitbucket"); // Cloud is untouched
  // Hosts that merely resemble bitbucket without the substring stay unclaimed.
  assert.equal(detectForge("git@bb.example.org:o/r.git"), null);
  assert.equal(detectForge("https://example.com/o/r"), null);
  // A forge.hosts claim wins over the heuristics and claims arbitrary hosts.
  assert.equal(
    detectForge("git@stash.internal:PROJ/repo.git", { "stash.internal": "bitbucket-server" }),
    "bitbucket-server"
  );
  assert.equal(detectForge("https://bitbucket.org/o/r", { "bitbucket.org": "bitbucket-server" }), "bitbucket-server");
});

test("loadPRs reads PRs through the stubbed API, keyed by fromRef branch, states mapped", async (t) => {
  const dir = mkRepo("https://bitbucket.corp/scm/PROJ/repo.git");
  process.env.BITBUCKET_TOKEN = "bs-token";
  const calls = [];
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.now(); // snapshot so fixture timestamps and assertions agree
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    assert.match(String(url), /bitbucket\.corp\/rest\/api\/1\.0\/projects\/PROJ\/repos\/repo\/pull-requests\?/);
    assert.match(String(url), /state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED/);
    assert.match(String(url), /limit=100&start=0/);
    return httpRes({
      values: [
        bsPr({ id: 42, version: 3, title: "open work", headRef: "feature/a", state: "OPEN", updatedDaysAgo: 2, now }),
        bsPr({ id: 41, title: "landed", headRef: "feature/b", state: "MERGED", updatedDaysAgo: 9, closedDaysAgo: 7, now }),
        bsPr({ id: 40, title: "closed without merge", headRef: "feature/c", state: "DECLINED", updatedDaysAgo: 5, now }),
        bsPr({ id: 39, title: "superseded", headRef: "feature/d", state: "SUPERSEDED", updatedDaysAgo: 6, now }),
      ],
      isLastPage: true,
    });
  };

  const res = await bitbucketServerProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.source, "api");
  assert.equal(res.provider, "bitbucket-server");
  assert.deepEqual({ owner: res.repo.owner, repo: res.repo.repo }, { owner: "PROJ", repo: "repo" });
  assert.equal(res.repo.host, "bitbucket.corp");
  assert.equal(res.repo.apiBase, API);
  assert.equal(res.truncated, false);

  const open = res.prs.get("feature/a")[0];
  assert.equal(open.number, 42);
  assert.equal(open.state, "open");
  assert.equal(open.isDraft, false);
  assert.equal(open.headRef, "feature/a");
  assert.equal(open.ageDays, 2);
  assert.equal(open.updatedAt, new Date(now - 2 * DAY).toISOString());
  assert.equal(open.url, "https://bitbucket.corp/projects/PROJ/repos/repo/pull-requests/42");
  assert.equal(open.version, 3); // carried for the versioned decline

  const merged = res.prs.get("feature/b")[0];
  assert.equal(merged.state, "merged");
  assert.equal(merged.mergedAt, new Date(now - 7 * DAY).toISOString());

  const declined = res.prs.get("feature/c")[0];
  assert.equal(declined.state, "closed"); // closed-without-merge, like Cloud
  const superseded = res.prs.get("feature/d")[0];
  assert.equal(superseded.state, "closed");
});

test("loadPRs follows nextPageStart cursors until isLastPage", async (t) => {
  const dir = mkRepo("https://bitbucket.corp/PROJ/repo.git");
  process.env.BITBUCKET_TOKEN = "bs-token";
  const calls = [];
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const start = Number(/start=(\d+)/.exec(String(url))?.[1] ?? 0);
    const page = start / 100;
    return httpRes({
      values: Array.from({ length: 2 }, (_, i) =>
        bsPr({ id: page * 2 + i + 1, title: `pr ${page}-${i}`, headRef: `b-${page}-${i}`, state: "OPEN", updatedDaysAgo: 3 })
      ),
      isLastPage: page >= 1, // two pages
      nextPageStart: 100,
    });
  };

  const res = await bitbucketServerProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /start=0/);
  assert.match(calls[1], /start=100/);
  assert.equal(res.prs.size, 4);
  assert.equal(res.truncated, false);
});

test("loadPRs reports truncation when the server keeps paging past the cap", async (t) => {
  const dir = mkRepo("https://bitbucket.corp/PROJ/repo.git");
  process.env.BITBUCKET_TOKEN = "bs-token";
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  globalThis.fetch = async () =>
    httpRes({
      values: Array.from({ length: 100 }, (_, i) =>
        bsPr({ id: i + 1, title: `pr ${i}`, headRef: `branch-${i}`, state: "OPEN", updatedDaysAgo: 30 })
      ),
      isLastPage: false, // never ends: the run must stop at the cap, loudly
      nextPageStart: 100,
    });

  const res = await bitbucketServerProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.truncated, true);
});

test("loadPRs degrades without a token and reports API failures", async (t) => {
  const dir = mkRepo("https://bitbucket.corp/scm/PROJ/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  const noToken = await bitbucketServerProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(noToken.source, "none");
  assert.match(noToken.error, /no BITBUCKET_TOKEN set/);

  process.env.BITBUCKET_TOKEN = "bs-token";
  t.after(() => delete process.env.BITBUCKET_TOKEN);
  globalThis.fetch = async () => httpRes({ errors: [{ message: "nope" }] }, 401);
  const failed = await bitbucketServerProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(failed.source, "none");
  assert.match(failed.error, /Bitbucket Server API 401/);
});

test("a repo without a Server remote reports so (a github remote is not claimed)", async (t) => {
  const dir = mkRepo("https://github.com/o/r.git");
  process.env.BITBUCKET_TOKEN = "bs-token";
  t.after(() => {
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  const res = await bitbucketServerProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.source, "none");
  assert.match(res.error, /no Bitbucket Server remote found/);
});

test("forge.loadPRs routes a bitbucket-server remote to the server provider end to end", async (t) => {
  const dir = mkRepo("git@bitbucket.example.org:PROJ/repo.git");
  process.env.BITBUCKET_TOKEN = "bs-token";
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  globalThis.fetch = async () => httpRes({ values: [], isLastPage: true });
  const res = await loadPRs({ cwd: dir, remotes: ["origin"], track: true, hostMap: {} });
  assert.equal(res.provider, "bitbucket-server");
  assert.equal(res.source, "api");
  assert.deepEqual({ owner: res.repo.owner, repo: res.repo.repo }, { owner: "PROJ", repo: "repo" });

  // A forge.hosts-claimed custom host dispatches too.
  const dir2 = mkRepo("git@stash.internal:PROJ/repo.git");
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  const res2 = await loadPRs({ cwd: dir2, remotes: ["origin"], track: true, hostMap: { "stash.internal": "bitbucket-server" } });
  assert.equal(res2.provider, "bitbucket-server");
});

test("closePR declines with the version lock and posts the comment as Server text", async (t) => {
  const dir = mkRepo("https://bitbucket.corp/scm/PROJ/repo.git");
  process.env.BITBUCKET_TOKEN = "bs-token";
  const calls = [];
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body, headers: init?.headers });
    return httpRes({});
  };
  const pr = {
    number: 7,
    version: 3,
    apiBase: API,
    title: "stale",
    state: "open",
    updatedAt: new Date().toISOString(),
  };
  await closePR({ provider: "bitbucket-server", owner: "PROJ", repo: "repo", source: "api", pr, comment: "closing this" });
  assert.equal(calls.length, 2);
  const decline = calls[0];
  assert.equal(decline.method, "POST");
  assert.equal(
    decline.url,
    "https://bitbucket.corp/rest/api/1.0/projects/PROJ/repos/repo/pull-requests/7/decline?version=3"
  );
  assert.equal(decline.headers.Authorization, "Bearer bs-token");
  const comment = calls[1];
  assert.equal(comment.url, "https://bitbucket.corp/rest/api/1.0/projects/PROJ/repos/repo/pull-requests/7/comments");
  assert.deepEqual(JSON.parse(comment.body), { text: "closing this" });
});

test("closePR refuses without a token", async (t) => {
  const dir = mkRepo("https://bitbucket.corp/scm/PROJ/repo.git");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    closePR({ provider: "bitbucket-server", owner: "PROJ", repo: "repo", source: "api", pr: { number: 7, apiBase: API }, comment: "" }),
    /no BITBUCKET_TOKEN set/
  );
});
