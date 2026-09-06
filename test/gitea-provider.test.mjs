// Gitea provider tests: remote parsing, PR loading via a stubbed API
// (state mapping, Link-header + x-total-count pagination, truncation),
// degradation without a token, and closing via PATCH. The HTTP layer is
// replaced with a fake `fetch`; remote detection runs against a real
// throwaway git repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { giteaProvider } from "../src/providers/gitea.mjs";
import { closePR, detectForge, loadPRs, providers } from "../src/forge.mjs";

const DAY = 24 * 60 * 60 * 1000;

function sh(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

/** Fresh repo with one commit and an optional gitea remote. */
function mkRepo(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "gc-gitea-test-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "f.txt"), "x");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "seed"]);
  if (remoteUrl) sh(dir, ["remote", "add", "origin", remoteUrl]);
  return dir;
}

function httpRes(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/** Gitea REST shape for one pull request (GitHub-compatible). */
function gPr({ number, title, headRef, state = "open", updatedDaysAgo, draft = false, merged = false }) {
  return {
    number,
    title,
    html_url: `https://gitea.com/team/repo/pulls/${number}`,
    head: { ref: headRef },
    draft,
    state: merged ? "closed" : state,
    updated_at: new Date(Date.now() - updatedDaysAgo * DAY).toISOString(),
    merged_at: merged ? new Date(Date.now() - (updatedDaysAgo - 1) * DAY).toISOString() : null,
  };
}

const origFetch = globalThis.fetch;

test("parseGiteaRemote handles known hosts and rejects others", () => {
  const p = giteaProvider.parseRemote;
  assert.deepEqual(p("https://gitea.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    host: "gitea.com",
    apiBase: "https://gitea.com/api/v1",
  });
  assert.deepEqual(p("git@gitea.com:owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    host: "gitea.com",
    apiBase: "https://gitea.com/api/v1",
  });
  assert.deepEqual(p("ssh://git@codeberg.org/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    host: "codeberg.org",
    apiBase: "https://codeberg.org/api/v1",
  });
  assert.deepEqual(p("https://forgejo.org/owner/repo"), {
    owner: "owner",
    repo: "repo",
    host: "forgejo.org",
    apiBase: "https://forgejo.org/api/v1",
  });
  // GITEA_API_BASE overrides every host.
  const prev = process.env.GITEA_API_BASE;
  try {
    process.env.GITEA_API_BASE = "https://gitea.example.internal/api/v1";
    assert.equal(p("https://gitea.com/owner/repo").apiBase, "https://gitea.example.internal/api/v1");
  } finally {
    if (prev === undefined) delete process.env.GITEA_API_BASE;
    else process.env.GITEA_API_BASE = prev;
  }
  // A custom SSH port is transport detail, not part of the namespace.
  assert.deepEqual(p("ssh://git@gitea.com:2222/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    host: "gitea.com",
    apiBase: "https://gitea.com/api/v1",
  });
  // Unknown and foreign hosts are not claimed.
  assert.equal(p("https://git.example.org/owner/repo"), null); // self-hosted Gitea
  assert.equal(p("https://github.com/owner/repo.git"), null);
  assert.equal(p("https://gitlab.com/owner/repo.git"), null);
  assert.equal(p("https://bitbucket.org/owner/repo.git"), null);
  assert.equal(p(""), null);
  assert.equal(p(null), null);
});

test("parseGiteaRemote and loadPRs accept forge.hosts-claimed custom domains", async (t) => {
  const hostMap = { "git.internal": "gitea" };
  // Without the map the host is not claimed.
  assert.equal(giteaProvider.parseRemote("git@git.internal:team/repo.git"), null);
  assert.deepEqual(giteaProvider.parseRemote("git@git.internal:team/repo.git", hostMap), {
    owner: "team",
    repo: "repo",
    host: "git.internal",
    apiBase: "https://git.internal/api/v1",
  });

  const dir = mkRepo("git@git.internal:team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITEA_TOKEN = "gitea-test";
  globalThis.fetch = async () => httpRes([gPr({ number: 1, title: "only", headRef: "feature/a", updatedDaysAgo: 3 })]);

  // Without the map the remote is unrecognized and PRs are not tracked.
  const none = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(none.source, "none");
  assert.match(none.error, /no Gitea remote found/);

  // With the map: detected, parsed, and read through the API.
  const res = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true, hostMap });
  assert.equal(res.provider, "gitea");
  assert.equal(res.source, "api");
  assert.deepEqual(res.repo, {
    owner: "team",
    repo: "repo",
    host: "git.internal",
    apiBase: "https://git.internal/api/v1",
  });
  assert.equal(res.prs.get("feature/a").length, 1);
});

test("gitea provider is registered and detected on gitea-family hosts only", () => {
  assert.ok(providers.gitea, "gitea provider registered");
  assert.equal(providers.gitea.id, "gitea");
  assert.equal(detectForge("https://gitea.com/o/r"), "gitea");
  assert.equal(detectForge("git@codeberg.org:o/r.git"), "gitea");
  assert.equal(detectForge("https://forgejo.org/o/r"), "gitea");
  assert.equal(detectForge("https://gitea.example.org/o/r"), null); // self-hosted: not claimed
  assert.equal(detectForge("https://example.com/o/r"), null);
});

test("loadPRs reads PRs through the stubbed API, keyed by source branch, states mapped", async (t) => {
  const dir = mkRepo("https://gitea.com/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITEA_TOKEN = "gt-token";

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    assert.match(u, /^https:\/\/gitea\.com\/api\/v1\/repos\/team\/repo\/pulls/);
    assert.match(u, /state=all/);
    assert.match(u, /sort=recentupdate/);
    assert.equal(init.headers.Authorization, "token gt-token");
    return httpRes([
      gPr({ number: 42, title: "Add feature", headRef: "feature/a", updatedDaysAgo: 2 }),
      gPr({ number: 7, title: "Old merged work", headRef: "feature/b", updatedDaysAgo: 90, merged: true }),
      gPr({ number: 9, title: "Closed without merge", headRef: "feature/c", state: "closed", updatedDaysAgo: 60 }),
      gPr({ number: 11, title: "Draft", headRef: "feature/d", updatedDaysAgo: 1, draft: true }),
    ]);
  };

  const res = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.provider, "gitea");
  assert.equal(res.source, "api");
  assert.deepEqual(res.repo, { owner: "team", repo: "repo", host: "gitea.com", apiBase: "https://gitea.com/api/v1" });
  assert.equal(res.error, null);
  assert.equal(res.truncated, false);

  const open = res.prs.get("feature/a")[0];
  assert.equal(open.number, 42);
  assert.equal(open.state, "open");
  assert.equal(open.isDraft, false);
  assert.equal(open.headRef, "feature/a");
  assert.equal(open.ageDays, 2);
  assert.equal(open.url, "https://gitea.com/team/repo/pulls/42");

  // Gitea marks merges the GitHub way: state closed + merged_at set.
  const merged = res.prs.get("feature/b")[0];
  assert.equal(merged.state, "merged");
  assert.ok(merged.mergedAt);

  const closed = res.prs.get("feature/c")[0];
  assert.equal(closed.state, "closed");

  const draft = res.prs.get("feature/d")[0];
  assert.equal(draft.isDraft, true);
});

test("loadPRs follows the Link header and reports truncation at the cap", async (t) => {
  const dir = mkRepo("https://codeberg.org/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITEA_TOKEN = "gt-token";

  let pages = 0;
  globalThis.fetch = async (url) => {
    const page = /page=(\d+)/.exec(String(url))?.[1];
    const n = page ? Number(page) : 1;
    pages = Math.max(pages, n);
    const items = Array.from({ length: 100 }, (_, i) =>
      gPr({ number: (n - 1) * 100 + i + 1, title: `pr ${n}-${i}`, headRef: `branch-${n}-${i}`, updatedDaysAgo: 30 })
    );
    return httpRes(items, 200, {
      link: `<https://codeberg.org/api/v1/repos/team/repo/pulls?page=${n + 1}>; rel="next"`,
      "x-total-count": "100000",
    });
  };

  const res = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.source, "api");
  assert.equal(res.truncated, true);
  assert.equal(pages, 20); // stopped at the cap
  assert.equal(res.prs.size, 2000);
});

test("loadPRs uses x-total-count when the Link header is absent", async (t) => {
  const dir = mkRepo("https://gitea.com/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITEA_TOKEN = "gt-token";

  const pages = [];
  globalThis.fetch = async (url) => {
    const page = /page=(\d+)/.exec(String(url))?.[1];
    const n = page ? Number(page) : 1;
    pages.push(n);
    return httpRes(
      Array.from({ length: 100 }, (_, i) =>
        gPr({ number: (n - 1) * 100 + i + 1, title: `pr ${i}`, headRef: `branch-${n}-${i}`, updatedDaysAgo: 5 })
      ),
      200,
      { "x-total-count": "250" } // no Link header; total tells us more exist
    );
  };

  const res = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.truncated, false);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(res.prs.size, 300);
});

test("loadPRs is not truncated when pagination ends naturally", async (t) => {
  const dir = mkRepo("https://gitea.com/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITEA_TOKEN = "gt-token";

  globalThis.fetch = async () => httpRes([gPr({ number: 1, title: "only", headRef: "feature/x", updatedDaysAgo: 3 })]);
  const res = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.truncated, false);
  assert.equal(res.prs.size, 1);
});

test("loadPRs degrades without a token and reports API failures", async (t) => {
  const dir = mkRepo("https://gitea.com/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  globalThis.fetch = async () => {
    throw new Error("fetch must not be called without a token");
  };
  const noToken = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(noToken.source, "none");
  assert.equal(noToken.provider, "gitea");
  assert.match(noToken.error, /GITEA_TOKEN/);
  assert.equal(noToken.prs.size, 0);

  process.env.GITEA_TOKEN = "gt-token";
  globalThis.fetch = async () => httpRes({ message: "Forbidden" }, 403);
  const failed = await giteaProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(failed.source, "none");
  assert.match(failed.error, /PR lookup failed: Gitea API 403/);
});

test("forge.loadPRs routes a codeberg remote to the gitea provider end to end", async (t) => {
  const dir = mkRepo("git@codeberg.org:team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITEA_TOKEN = "gt-token";
  globalThis.fetch = async () => httpRes([gPr({ number: 42, title: "x", headRef: "feature/a", updatedDaysAgo: 5 })]);

  const res = await loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.provider, "gitea");
  assert.equal(res.source, "api");
  assert.equal(res.repo.host, "codeberg.org");
  assert.equal(res.prs.get("feature/a")[0].number, 42);
});

test("closePR closes via PATCH and posts a comment when given", async (t) => {
  const calls = [];
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
  });
  process.env.GITEA_TOKEN = "gt-token";
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body ?? null });
    return httpRes({});
  };

  const pr = { number: 42, apiBase: "https://codeberg.org/api/v1" };
  await closePR({ provider: "gitea", owner: "team", repo: "repo", source: "api", pr, comment: "closing" });

  assert.equal(calls.length, 2);
  const patch = calls[0];
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url, "https://codeberg.org/api/v1/repos/team/repo/pulls/42");
  assert.equal(patch.headers.Authorization, "token gt-token");
  assert.deepEqual(JSON.parse(patch.body), { state: "closed" });
  const comment = calls[1];
  assert.equal(comment.method, "POST");
  assert.equal(comment.url, "https://codeberg.org/api/v1/repos/team/repo/issues/42/comments");
  assert.deepEqual(JSON.parse(comment.body), { body: "closing" });
});

test("closePR fails cleanly on API errors and without a token", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITEA_TOKEN;
  });

  globalThis.fetch = async () => {
    throw new Error("fetch must not be called");
  };
  await assert.rejects(
    () =>
      closePR({
        provider: "gitea",
        owner: "o",
        repo: "r",
        source: "api",
        pr: { number: 1 },
        comment: "",
      }),
    /no GITEA_TOKEN set/
  );

  process.env.GITEA_TOKEN = "gt-token";
  globalThis.fetch = async () => httpRes({ message: "Not Found" }, 404);
  await assert.rejects(
    () =>
      closePR({
        provider: "gitea",
        owner: "o",
        repo: "r",
        source: "api",
        pr: { number: 1 },
        comment: "",
      }),
    /Gitea API 404/
  );
});
