// Bitbucket provider tests: remote parsing, PR loading via a stubbed API
// (state mapping, pagination, truncation), degradation without a token, and
// closing via the decline endpoint. The HTTP layer is replaced with a fake
// `fetch`; remote detection runs against a real throwaway git repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { bitbucketProvider } from "../src/providers/bitbucket.mjs";
import { closePR, detectForge, loadPRs, providers } from "../src/forge.mjs";

const DAY = 24 * 60 * 60 * 1000;

function sh(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

/** Fresh repo with one commit and an optional bitbucket remote. */
function mkRepo(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "gc-bitbucket-test-"));
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

/** Bitbucket Cloud REST shape for one pull request. */
function bbPr({ id, title, headRef, state, updatedDaysAgo, draft = false, closedDaysAgo = null, owner = "team", repo = "repo" }) {
  return {
    id,
    title,
    state, // "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED"
    links: { html: { href: `https://bitbucket.org/${owner}/${repo}/pull-requests/${id}` } },
    source: { branch: { name: headRef } },
    draft,
    updated_on: new Date(Date.now() - updatedDaysAgo * DAY).toISOString(),
    closed_on: closedDaysAgo === null ? null : new Date(Date.now() - closedDaysAgo * DAY).toISOString(),
  };
}

const origFetch = globalThis.fetch;

test("parseBitbucketRemote handles https, ssh, scp-like and rejects others", () => {
  const p = bitbucketProvider.parseRemote;
  assert.deepEqual(p("https://bitbucket.org/team/repo.git"), { owner: "team", repo: "repo" });
  assert.deepEqual(p("https://bitbucket.org/team/repo"), { owner: "team", repo: "repo" });
  assert.deepEqual(p("git@bitbucket.org:team/repo.git"), { owner: "team", repo: "repo" });
  assert.deepEqual(p("ssh://git@bitbucket.org/team/repo.git"), { owner: "team", repo: "repo" });
  assert.equal(p("https://github.com/owner/repo.git"), null);
  assert.equal(p("https://bitbucket.org/"), null);
  assert.equal(p("https://gitlab.com/team/repo.git"), null);
  assert.equal(p(""), null);
  assert.equal(p(null), null);
});

test("bitbucket provider is registered and detected; self-hosted is not claimed", () => {
  assert.ok(providers.bitbucket, "bitbucket provider registered");
  assert.equal(providers.bitbucket.id, "bitbucket");
  assert.equal(detectForge("https://bitbucket.org/o/r"), "bitbucket");
  assert.equal(detectForge("git@bitbucket.org:o/r.git"), "bitbucket");
  // Bitbucket Server has a different API; hosts that merely resemble
  // bitbucket must NOT be claimed.
  assert.equal(detectForge("git@bb.example.org:o/r.git"), null);
  assert.equal(detectForge("https://example.com/o/r"), null);
});

test("loadPRs reads PRs through the stubbed API, keyed by source branch, states mapped", async (t) => {
  const dir = mkRepo("https://bitbucket.org/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.BITBUCKET_TOKEN = "bb-token";

  globalThis.fetch = async (url, init = {}) => {
    assert.match(String(url), /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/team\/repo\/pullrequests/);
    assert.equal(init.headers.Authorization, "Bearer bb-token");
    return httpRes({
      values: [
        bbPr({ id: 42, title: "Add feature", headRef: "feature/a", state: "OPEN", updatedDaysAgo: 2 }),
        bbPr({ id: 7, title: "Old merged work", headRef: "feature/b", state: "MERGED", updatedDaysAgo: 90, closedDaysAgo: 88 }),
        bbPr({ id: 9, title: "Declined", headRef: "feature/c", state: "DECLINED", updatedDaysAgo: 60 }),
        bbPr({ id: 11, title: "Superseded", headRef: "feature/c", state: "SUPERSEDED", updatedDaysAgo: 30 }),
        bbPr({ id: 12, title: "Draft", headRef: "feature/d", state: "OPEN", updatedDaysAgo: 1, draft: true }),
      ],
    });
  };

  const res = await bitbucketProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.provider, "bitbucket");
  assert.equal(res.source, "api");
  assert.deepEqual(res.repo, { owner: "team", repo: "repo" });
  assert.equal(res.error, null);
  assert.equal(res.truncated, false);

  const open = res.prs.get("feature/a")[0];
  assert.equal(open.number, 42);
  assert.equal(open.state, "open");
  assert.equal(open.isDraft, false);
  assert.equal(open.headRef, "feature/a");
  assert.equal(open.ageDays, 2);
  assert.equal(open.url, "https://bitbucket.org/team/repo/pull-requests/42");

  const merged = res.prs.get("feature/b")[0];
  assert.equal(merged.state, "merged");
  assert.ok(merged.mergedAt);
  assert.equal(merged.isDraft, false);

  // Closed-without-merge states both map to "closed" (abandoned-PR signal).
  const declined = res.prs.get("feature/c").find((p) => p.number === 9);
  assert.equal(declined.state, "closed");
  const superseded = res.prs.get("feature/c").find((p) => p.number === 11);
  assert.equal(superseded.state, "closed");

  const draft = res.prs.get("feature/d")[0];
  assert.equal(draft.isDraft, true);
});

test("loadPRs follows next-page URLs and reports truncation at the cap", async (t) => {
  const dir = mkRepo("https://bitbucket.org/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.BITBUCKET_TOKEN = "bb-token";

  globalThis.fetch = async (url) => {
    const page = /page=(\d+)/.exec(String(url))?.[1];
    const n = page ? Number(page) : 1;
    return httpRes({
      values: Array.from({ length: 100 }, (_, i) =>
        bbPr({ id: (n - 1) * 100 + i + 1, title: `pr ${n}-${i}`, headRef: `branch-${n}-${i}`, state: "OPEN", updatedDaysAgo: 30 })
      ),
      // Bitbucket embeds the next URL in the body; keep it alive past the cap.
      next: `https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests?page=${n + 1}`,
    });
  };

  const res = await bitbucketProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.source, "api");
  assert.equal(res.truncated, true);
  assert.equal(res.prs.size, 2000); // stopped at the cap, page 20
});

test("loadPRs is not truncated when pagination ends naturally", async (t) => {
  const dir = mkRepo("https://bitbucket.org/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.BITBUCKET_TOKEN = "bb-token";

  globalThis.fetch = async () => httpRes({ values: [bbPr({ id: 1, title: "only", headRef: "feature/x", state: "OPEN", updatedDaysAgo: 3 })] });
  const res = await bitbucketProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.truncated, false);
  assert.equal(res.prs.size, 1);
});

test("loadPRs degrades without a token and reports API failures", async (t) => {
  const dir = mkRepo("https://bitbucket.org/team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  globalThis.fetch = async () => {
    throw new Error("fetch must not be called without a token");
  };
  const noToken = await bitbucketProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(noToken.source, "none");
  assert.equal(noToken.provider, "bitbucket");
  assert.match(noToken.error, /BITBUCKET_TOKEN/);
  assert.equal(noToken.prs.size, 0);

  process.env.BITBUCKET_TOKEN = "bb-token";
  globalThis.fetch = async () => httpRes({ message: "Unauthorized" }, 401);
  const failed = await bitbucketProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(failed.source, "none");
  assert.match(failed.error, /PR lookup failed: Bitbucket API 401/);
});

test("forge.loadPRs routes a bitbucket remote to the bitbucket provider end to end", async (t) => {
  const dir = mkRepo("git@bitbucket.org:team/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.BITBUCKET_TOKEN = "bb-token";
  globalThis.fetch = async () => httpRes({ values: [bbPr({ id: 42, title: "x", headRef: "feature/a", state: "OPEN", updatedDaysAgo: 5 })] });

  const res = await loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.provider, "bitbucket");
  assert.equal(res.source, "api");
  assert.equal(res.repo.owner, "team");
  assert.equal(res.prs.get("feature/a")[0].number, 42);
});

test("closePR declines via the API and posts a comment when given", async (t) => {
  const calls = [];
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
  });
  process.env.BITBUCKET_TOKEN = "bb-token";
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body ?? null });
    return httpRes({});
  };

  const pr = { number: 42 };
  await closePR({ provider: "bitbucket", owner: "team", repo: "repo", source: "api", pr, comment: "closing" });

  assert.equal(calls.length, 2);
  const decline = calls[0];
  assert.equal(decline.method, "POST");
  assert.equal(
    decline.url,
    "https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests/42/decline"
  );
  assert.equal(decline.headers.Authorization, "Bearer bb-token");
  const comment = calls[1];
  assert.equal(comment.method, "POST");
  assert.equal(
    comment.url,
    "https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests/42/comments"
  );
  assert.deepEqual(JSON.parse(comment.body), { content: { raw: "closing" } });
});

test("closePR fails cleanly on API errors and without a token", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.BITBUCKET_TOKEN;
  });

  globalThis.fetch = async () => {
    throw new Error("fetch must not be called");
  };
  await assert.rejects(
    () =>
      closePR({
        provider: "bitbucket",
        owner: "o",
        repo: "r",
        source: "api",
        pr: { number: 1 },
        comment: "",
      }),
    /no BITBUCKET_TOKEN set/
  );

  process.env.BITBUCKET_TOKEN = "bb-token";
  globalThis.fetch = async () => httpRes({ message: "Not Found" }, 404);
  await assert.rejects(
    () =>
      closePR({
        provider: "bitbucket",
        owner: "o",
        repo: "r",
        source: "api",
        pr: { number: 1 },
        comment: "",
      }),
    /Bitbucket API 404/
  );
});
