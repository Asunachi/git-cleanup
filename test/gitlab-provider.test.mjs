// GitLab provider tests: remote parsing, MR loading via a stubbed API, and
// closing via a stubbed API. The HTTP layer is replaced with a fake `fetch`;
// remote detection runs against a real throwaway git repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { gitlabProvider } from "../src/providers/gitlab.mjs";
import { closePR, detectForge, loadPRs, providers } from "../src/forge.mjs";

const DAY = 24 * 60 * 60 * 1000;

function sh(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

/** Fresh repo with one commit and an optional gitlab remote. */
function mkRepo(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "gc-gitlab-test-"));
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

const MR_OPEN = {
  iid: 42,
  title: "Add feature",
  web_url: "https://gitlab.com/group/sub/repo/-/merge_requests/42",
  source_branch: "feature/a",
  draft: false,
  state: "opened",
  updated_at: new Date(Date.now() - 2 * DAY).toISOString(),
  merged_at: null,
};
const MR_MERGED = {
  iid: 7,
  title: "Old merged work",
  web_url: "https://gitlab.com/group/sub/repo/-/merge_requests/7",
  source_branch: "feature/b",
  draft: true,
  state: "merged",
  updated_at: new Date(Date.now() - 90 * DAY).toISOString(),
  merged_at: new Date(Date.now() - 88 * DAY).toISOString(),
};

const origFetch = globalThis.fetch;

test("parseGitLabRemote handles https, ssh, nested groups and self-hosted", () => {
  const p = gitlabProvider.parseRemote;
  assert.deepEqual(p("https://gitlab.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    host: "gitlab.com",
    apiBase: "https://gitlab.com/api/v4",
  });
  assert.deepEqual(p("git@gitlab.com:owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    host: "gitlab.com",
    apiBase: "https://gitlab.com/api/v4",
  });
  assert.deepEqual(p("ssh://git@gitlab.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    host: "gitlab.com",
    apiBase: "https://gitlab.com/api/v4",
  });
  // Nested groups stay in owner, joined by "/".
  assert.deepEqual(p("https://gitlab.com/group/sub/repo.git"), {
    owner: "group/sub",
    repo: "repo",
    host: "gitlab.com",
    apiBase: "https://gitlab.com/api/v4",
  });
  // Self-hosted instances use https://<host>/api/v4.
  assert.deepEqual(p("git@gitlab.example.org:group/repo.git"), {
    owner: "group",
    repo: "repo",
    host: "gitlab.example.org",
    apiBase: "https://gitlab.example.org/api/v4",
  });
  assert.equal(p("https://github.com/owner/repo.git"), null);
  assert.equal(p("https://gitlab.com/"), null);
  assert.equal(p(""), null);
  assert.equal(p(null), null);
});

test("gitlab provider is registered and detectable", () => {
  assert.ok(providers.gitlab, "gitlab provider registered");
  assert.equal(providers.gitlab.id, "gitlab");
  assert.equal(detectForge("https://gitlab.com/o/r"), "gitlab");
  assert.equal(detectForge("git@gitlab.example.org:o/r.git"), "gitlab");
});

test("loadPRs reads MRs through the stubbed API, keyed by source branch", async (t) => {
  const dir = mkRepo("https://gitlab.com/group/sub/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITLAB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITLAB_TOKEN = "glpat-test";

  globalThis.fetch = async (url) => {
    const page = /(?:^|[?&])page=(\d+)/.exec(String(url))?.[1] ?? "1";
    const items = page === "1" ? [MR_OPEN, MR_MERGED] : [];
    return httpRes(items);
  };

  const res = await gitlabProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.provider, "gitlab");
  assert.equal(res.source, "api");
  assert.deepEqual(res.repo, {
    owner: "group/sub",
    repo: "repo",
    host: "gitlab.com",
    apiBase: "https://gitlab.com/api/v4",
  });
  assert.equal(res.error, null);
  assert.equal(res.prs.get("feature/a").length, 1);

  const open = res.prs.get("feature/a")[0];
  assert.equal(open.number, 42); // GitLab iid, project-scoped
  assert.equal(open.state, "open");
  assert.equal(open.isDraft, false);
  assert.equal(open.headRef, "feature/a");
  assert.equal(open.ageDays, 2);
  assert.equal(open.apiBase, "https://gitlab.com/api/v4");

  const merged = res.prs.get("feature/b")[0];
  assert.equal(merged.state, "merged");
  assert.equal(merged.isDraft, true);
  assert.equal(merged.ageDays, 90);
  assert.ok(merged.mergedAt);
});

test("loadPRs degrades without a token, and reports API failures", async (t) => {
  const dir = mkRepo("https://gitlab.com/owner/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITLAB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  // No token -> source none with a helpful message (no HTTP attempted).
  globalThis.fetch = async () => {
    throw new Error("fetch must not be called without a token");
  };
  const noToken = await gitlabProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(noToken.source, "none");
  assert.equal(noToken.provider, "gitlab");
  assert.match(noToken.error, /GITLAB_TOKEN/);
  assert.equal(noToken.prs.size, 0);

  // Token but failing API -> source none with the API error surfaced.
  process.env.GITLAB_TOKEN = "glpat-test";
  globalThis.fetch = async () => httpRes({ message: "Forbidden" }, 403);
  const failed = await gitlabProvider.loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(failed.source, "none");
  assert.match(failed.error, /PR lookup failed: GitLab API 403/);
});

test("forge.loadPRs routes a gitlab remote to the gitlab provider end to end", async (t) => {
  const dir = mkRepo("git@gitlab.com:owner/repo.git");
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITLAB_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.GITLAB_TOKEN = "glpat-test";
  globalThis.fetch = async () => httpRes([MR_OPEN]);

  const res = await loadPRs({ cwd: dir, remotes: ["origin"], track: true });
  assert.equal(res.provider, "gitlab");
  assert.equal(res.source, "api");
  assert.equal(res.repo.owner, "owner");
  assert.equal(res.prs.get("feature/a")[0].number, 42);
});

test("closePR closes via the API and posts a comment when given", async (t) => {
  const calls = [];
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITLAB_TOKEN;
  });
  process.env.GITLAB_TOKEN = "glpat-test";
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET", body: opts.body ?? null });
    return httpRes({});
  };

  const pr = { number: 42, apiBase: "https://gitlab.com/api/v4" };
  await closePR({ provider: "gitlab", owner: "group/sub", repo: "repo", source: "api", pr, comment: "closing" });

  assert.equal(calls.length, 2);
  const put = calls[0];
  assert.equal(put.method, "PUT");
  assert.equal(
    put.url,
    "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/merge_requests/42"
  );
  assert.deepEqual(JSON.parse(put.body), { state_event: "close" });
  const note = calls[1];
  assert.equal(note.method, "POST");
  assert.equal(
    note.url,
    "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/merge_requests/42/notes"
  );
  assert.deepEqual(JSON.parse(note.body), { body: "closing" });
});

test("closePR fails cleanly on API errors and without a token", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
    delete process.env.GITLAB_TOKEN;
  });

  // No token -> clean error before any HTTP.
  globalThis.fetch = async () => {
    throw new Error("fetch must not be called");
  };
  await assert.rejects(
    () =>
      closePR({
        provider: "gitlab",
        owner: "o",
        repo: "r",
        source: "api",
        pr: { number: 1, apiBase: "https://gitlab.com/api/v4" },
        comment: "",
      }),
    /no GITLAB_TOKEN set/
  );

  process.env.GITLAB_TOKEN = "glpat-test";
  globalThis.fetch = async () => httpRes({ message: "Not Found" }, 404);
  await assert.rejects(
    () =>
      closePR({
        provider: "gitlab",
        owner: "o",
        repo: "r",
        source: "api",
        pr: { number: 1, apiBase: "https://gitlab.com/api/v4" },
        comment: "",
      }),
    /GitLab API 404/
  );
});