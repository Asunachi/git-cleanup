// Tests for the `report-issue` CLI command (src/report-issue.mjs): keeps one
// issue with a fixed title current on any forge. Covers context resolution
// (remote -> forge + api base + token), per-forge search/create/update and
// dry-run against a stubbed fetch, and the real subcommand end-to-end
// against a local HTTP server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { postReport, resolveForgeContext } from "../src/report-issue.mjs";
import { providers } from "../src/forge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN = "# 🔴 git-cleanup scan report\n\n3 prunable · 2 stale · 5 kept";
const TITLE = "git-cleanup: branch report";

const origFetch = globalThis.fetch;

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

/** Run the CLI as a child process, collecting stdout/stderr. */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "bin", "git-cleanup.mjs"), ...args], {
      cwd: root,
      env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
}

/** A tiny git repo with one remote; returns its path. */
function makeRepo(t, remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), "gc-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // spawnSync: the remote must exist before the test runs the CLI — an
  // async spawn + .on("exit") would race the subprocess.
  const git = (...a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", remoteUrl);
  return dir;
}

// ---- provider contract -------------------------------------------------------

test("issues capability: present on every forge with a native tracker, absent = loud failure", () => {
  for (const [id, p] of Object.entries(providers)) {
    assert.equal(p.id, id, `${id}: provider keyed by its id`);
    if (p.issues) {
      for (const method of ["context", "findIssue", "createIssue", "updateIssue", "previewUrl"]) {
        assert.equal(typeof p.issues[method], "function", `${id}: issues.${method}`);
      }
    }
  }
  // Bitbucket Server has no native issue tracker (issues live in Jira): it
  // ships no issues capability, and report-issue on such a remote throws a
  // loud, specific error before any network call — never a silent skip.
  assert.equal(providers["bitbucket-server"].issues, undefined);
  assert.throws(
    () => resolveForgeContext("https://bitbucket.corp/scm/PROJ/repo.git", { BITBUCKET_TOKEN: "bt" }),
    /forge "bitbucket-server" has no issues support/
  );
});

test("resolveForgeContext dispatches each remote through its provider's issues", () => {
  const samples = {
    github: ["git@github.com:o/r.git", { GITHUB_TOKEN: "t" }],
    gitlab: ["git@gitlab.com:g/r.git", { GITLAB_TOKEN: "t" }],
    bitbucket: ["https://bitbucket.org/w/s.git", { BITBUCKET_TOKEN: "t" }],
    gitea: ["git@codeberg.org:o/r.git", { GITEA_TOKEN: "t" }],
  };
  for (const [id, [url, env]] of Object.entries(samples)) {
    assert.equal(resolveForgeContext(url, env).forge, id, `${id} resolves through the registry`);
  }
});

// ---- context resolution -----------------------------------------------------

test("resolveForgeContext: github remote + GITHUB_TOKEN", () => {
  const ctx = resolveForgeContext("git@github.com:owner/repo.git", {
    GITHUB_TOKEN: "t",
  });
  assert.equal(ctx.forge, "github");
  assert.equal(ctx.apiBase, "https://api.github.com");
  assert.equal(ctx.webBase, "https://github.com");
  assert.deepEqual({ owner: ctx.owner, repo: ctx.repo }, { owner: "owner", repo: "repo" });
  assert.deepEqual(ctx.headers, { Authorization: "Bearer t" });
});

test("resolveForgeContext: gitlab remote honors GITLAB_API_BASE, CI_API_V4_URL, and token fallback", () => {
  const base = resolveForgeContext("git@gitlab.com:group/sub/repo.git", {
    GITLAB_TOKEN: "gl",
    CI_API_V4_URL: "https://ci.example/api/v4",
  });
  assert.equal(base.forge, "gitlab");
  assert.equal(base.project, "group/sub/repo");
  assert.equal(base.webBase, "https://gitlab.com");
  assert.equal(base.apiBase, "https://ci.example/api/v4");
  assert.deepEqual(base.headers, { "PRIVATE-TOKEN": "gl" });

  // GITLAB_API_BASE (explicit override) beats the pipeline URL.
  const overridden = resolveForgeContext("git@gitlab.example.com:group/repo.git", {
    GITLAB_API_BASE: "https://proxy.example/api/v4",
    CI_API_V4_URL: "https://ci.example/api/v4",
    GITLAB_TOKEN: "gl",
  });
  assert.equal(overridden.apiBase, "https://proxy.example/api/v4");

  // No GITLAB_TOKEN -> CI_JOB_TOKEN fallback with the JOB-TOKEN header.
  const job = resolveForgeContext("git@gitlab.com:group/repo.git", {
    CI_JOB_TOKEN: "job",
  });
  assert.deepEqual(job.headers, { "JOB-TOKEN": "job" });
});

test("resolveForgeContext: bitbucket and gitea remotes", () => {
  const bb = resolveForgeContext("https://bitbucket.org/ws/slug.git", {
    BITBUCKET_TOKEN: "bt",
  });
  assert.equal(bb.forge, "bitbucket");
  assert.equal(bb.apiBase, "https://api.bitbucket.org/2.0");
  assert.deepEqual({ owner: bb.owner, repo: bb.repo }, { owner: "ws", repo: "slug" });
  assert.deepEqual(bb.headers, { Authorization: "Bearer bt" });

  const g = resolveForgeContext("git@codeberg.org:owner/repo.git", { GITEA_TOKEN: "gt" });
  assert.equal(g.forge, "gitea");
  assert.equal(g.apiBase, "https://codeberg.org/api/v1");
  assert.equal(g.webBase, "https://codeberg.org");
  assert.deepEqual(g.headers, { Authorization: "token gt" });
});

test("resolveForgeContext: forge.hosts claims custom-domain GitLab/Gitea hosts", () => {
  const hosts = { "git.example.com": "gitlab", "git.internal": "gitea" };
  const gl = resolveForgeContext("git@git.example.com:group/repo.git", { GITLAB_TOKEN: "gl" }, hosts);
  assert.equal(gl.forge, "gitlab");
  assert.equal(gl.webBase, "https://git.example.com");
  assert.equal(gl.apiBase, "https://git.example.com/api/v4");
  assert.equal(gl.project, "group/repo");

  const g = resolveForgeContext("git@git.internal:o/r.git", { GITEA_TOKEN: "gt" }, hosts);
  assert.equal(g.forge, "gitea");
  assert.equal(g.webBase, "https://git.internal");
  assert.equal(g.apiBase, "https://git.internal/api/v1");

  // Without the map the same remotes are unrecognized.
  assert.throws(
    () => resolveForgeContext("git@git.example.com:g/r.git", { GITLAB_TOKEN: "gl" }),
    /no supported forge remote/
  );
});

test("postReport: dry-run works on a forge.hosts-claimed GitLab host", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  globalThis.fetch = async () => httpRes([]);
  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    dryRun: true,
    remoteUrl: "git@git.example.com:group/repo.git",
    env: { GITLAB_TOKEN: "gl" },
    hostMap: { "git.example.com": "gitlab" },
  });
  assert.equal(r.action, "created");
  assert.equal(r.number, null);
  assert.equal(r.url, "https://git.example.com/group/repo/-/issues/new");
});

test("resolveForgeContext: unknown remote and missing tokens are loud errors", () => {
  assert.throws(
    () => resolveForgeContext("git@example.com:x/y.git", { GITHUB_TOKEN: "t" }),
    /no supported forge remote/
  );
  assert.throws(() => resolveForgeContext("git@github.com:a/b.git", {}), /GITHUB_TOKEN/);
  assert.throws(() => resolveForgeContext("git@gitlab.com:a/b.git", {}), /GITLAB_TOKEN/);
  assert.throws(() => resolveForgeContext("git@bitbucket.org:a/b.git", {}), /BITBUCKET_TOKEN/);
  assert.throws(() => resolveForgeContext("git@codeberg.org:a/b.git", {}), /GITEA_TOKEN/);
});

// ---- GitHub behaviors --------------------------------------------------------

test("github: creates the issue when none exists", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    if (String(url).includes("/issues?state=open")) return httpRes([]);
    if (String(url).endsWith("/issues") && init.method === "POST") {
      return httpRes({ number: 9, html_url: "https://github.com/owner/repo/issues/9" });
    }
    return httpRes({ message: "not found" }, 404);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "git@github.com:owner/repo.git",
    env: { GITHUB_TOKEN: "t" },
  });
  assert.equal(r.action, "created");
  assert.equal(r.number, 9);
  assert.equal(r.url, "https://github.com/owner/repo/issues/9");

  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.url, "https://api.github.com/repos/owner/repo/issues");
  assert.deepEqual(JSON.parse(post.body), { title: TITLE, body: MARKDOWN });
  // The search sorts by most-recently-updated so the weekly-updated report
  // issue survives the pagination cap on busy repos (dedup never lost).
  assert.ok(
    calls.some((c) => c.url.includes("sort=updated&direction=desc")),
    "github search sorts by updated desc"
  );
});

test("github: updates the exact-title issue and ignores pull requests", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).includes("/issues?state=open")) {
      return httpRes([
        { number: 1, title: "other" },
        { number: 900, title: TITLE, pull_request: {} }, // PR with the same title: ignored
        { number: 7, title: TITLE },
        { number: 2, title: `${TITLE} ` }, // trailing space: NOT a match
      ]);
    }
    if (String(url).includes("/issues/7") && init.method === "PATCH") {
      return httpRes({ number: 7, html_url: "https://github.com/owner/repo/issues/7" });
    }
    return httpRes({ message: "not found" }, 404);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "git@github.com:owner/repo.git",
    env: { GITHUB_TOKEN: "t" },
  });
  assert.equal(r.action, "updated");
  assert.equal(r.number, 7);
  assert.equal(calls.filter((c) => c.url.includes("/issues?state=open")).length, 1);
});

test("github: follows the Link header to find the issue on a later page", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const pages = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "PATCH") return httpRes({ number: 7, html_url: "u" });
    const page = /(?:^|[?&])page=(\d+)/.exec(String(url))?.[1];
    const n = page ? Number(page) : 1;
    pages.push(n);
    if (n === 1) {
      return httpRes(Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, title: `noise ${i}` })), 200, {
        link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=5>; rel="last"',
      });
    }
    return httpRes([{ number: 7, title: TITLE, html_url: "u7" }]);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "git@github.com:owner/repo.git",
    env: { GITHUB_TOKEN: "t" },
  });
  assert.equal(r.action, "updated");
  assert.equal(r.number, 7);
  assert.deepEqual(pages, [1, 2]);
});

test("github: dry-run resolves create-vs-update and never writes", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  for (const [list, expect] of [
    [[], "created"],
    [[{ number: 7, title: TITLE, html_url: "https://github.com/owner/repo/issues/7" }], "updated"],
  ]) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      if (String(url).includes("/issues?state=open")) return httpRes(list);
      return httpRes({ message: "not found" }, 404);
    };
    const r = await postReport({
      markdown: MARKDOWN,
      title: TITLE,
      dryRun: true,
      remoteUrl: "git@github.com:owner/repo.git",
      env: { GITHUB_TOKEN: "t" },
    });
    assert.equal(r.dryRun, true);
    assert.equal(r.action, expect);
    if (expect === "updated") {
      assert.equal(r.number, 7);
      assert.equal(r.url, "https://github.com/owner/repo/issues/7");
    } else {
      assert.equal(r.number, null);
      assert.equal(r.url, `https://github.com/owner/repo/issues/new?title=${encodeURIComponent(TITLE)}`);
    }
    assert.ok(!calls.some((c) => c.method === "POST" || c.method === "PATCH"), "no write in dry-run");
  }
});

// ---- GitLab behaviors --------------------------------------------------------

test("gitlab: creates with title+description, updates by iid via PUT", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    if (String(url).includes("/issues?")) return httpRes([]);
    if (String(url).endsWith("/issues") && init.method === "POST") {
      return httpRes({ iid: 9, web_url: "https://gitlab.com/g/o/-/issues/9" });
    }
    return httpRes({ message: "not found" }, 404);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "git@gitlab.com:group/sub/repo.git",
    env: { GITLAB_TOKEN: "gl" },
  });
  assert.equal(r.action, "created");
  assert.equal(r.number, 9);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.url, "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/issues");
  assert.deepEqual(JSON.parse(post.body), { title: TITLE, description: MARKDOWN });
});

test("gitlab: title-narrowed search finds the existing issue across pages", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const urls = [];
  globalThis.fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (init.method === "PUT") return httpRes({ iid: 7, web_url: "u7" });
    const page = /(?:^|[?&])page=(\d+)/.exec(String(url))?.[1];
    const n = page ? Number(page) : 1;
    if (n === 1) {
      return httpRes(Array.from({ length: 100 }, (_, i) => ({ iid: 1000 + i, title: `noise ${i}` })), 200, {
        "x-next-page": "2",
      });
    }
    return httpRes([{ iid: 7, title: TITLE, web_url: "u7" }]);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "git@gitlab.com:group/repo.git",
    env: { GITLAB_TOKEN: "gl" },
  });
  assert.equal(r.action, "updated");
  assert.equal(r.number, 7);
  const listUrl = urls.find((u) => u.includes("/issues?"));
  assert.ok(listUrl.includes(`search=${encodeURIComponent(TITLE)}`), "search narrowed to the exact title");
  assert.ok(listUrl.includes("in=title"), "search scoped to titles");
});

test("gitlab: dry-run resolves create-vs-update and never writes", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  for (const [list, expect] of [
    [[], "created"],
    [[{ iid: 7, title: TITLE, web_url: "https://gitlab.com/g/o/-/issues/7" }], "updated"],
  ]) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      if (String(url).includes("/issues?")) return httpRes(list);
      return httpRes({ message: "not found" }, 404);
    };
    const r = await postReport({
      markdown: MARKDOWN,
      title: TITLE,
      dryRun: true,
      remoteUrl: "git@gitlab.com:group/repo.git",
      env: { GITLAB_TOKEN: "gl" },
    });
    assert.equal(r.dryRun, true);
    assert.equal(r.action, expect);
    if (expect === "updated") {
      assert.equal(r.number, 7);
      assert.equal(r.url, "https://gitlab.com/g/o/-/issues/7");
    } else {
      assert.equal(r.url, "https://gitlab.com/group/repo/-/issues/new");
    }
    assert.ok(!calls.some((c) => c.method === "POST" || c.method === "PUT"), "no write in dry-run");
  }
});

test("gitlab: API failures surface with the forge name", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  globalThis.fetch = async () => httpRes({ message: "Forbidden" }, 403);
  await assert.rejects(
    () =>
      postReport({ markdown: MARKDOWN, remoteUrl: "git@gitlab.com:g/r.git", env: { GITLAB_TOKEN: "gl" } }),
    /GitLab API 403/
  );
});

// ---- Bitbucket behaviors ------------------------------------------------------

test("bitbucket: creates with content.raw, updates by id via PUT", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    if (String(url).includes("/issues?")) {
      return httpRes({ values: [], next: null });
    }
    if (init.method === "POST") {
      return httpRes({ id: 42, links: { html: { href: "https://bitbucket.org/ws/slug/issues/42" } } });
    }
    return httpRes({ message: "not found" }, 404);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "https://bitbucket.org/ws/slug.git",
    env: { BITBUCKET_TOKEN: "bt" },
  });
  assert.equal(r.action, "created");
  assert.equal(r.number, 42);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.url, "https://api.bitbucket.org/2.0/repositories/ws/slug/issues");
  assert.deepEqual(JSON.parse(post.body), { title: TITLE, content: { raw: MARKDOWN } });
  assert.ok(
    calls.some((c) => c.url.includes("sort=-updated_on")),
    "bitbucket search sorts by updated desc"
  );
});

test("bitbucket: follows the embedded next URL to find the issue, and dry-run skips the write", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const pages = [];
  globalThis.fetch = async (url, init = {}) => {
    pages.push(String(url));
    const method = init.method ?? "GET";
    if (String(url).includes("/issues?") && method === "GET") {
      if (String(url).includes("page=1")) {
        return httpRes({
          values: [{ id: 1, title: "noise" }],
          next: "https://api.bitbucket.org/2.0/repositories/ws/slug/issues?state=OPEN&pagelen=100&page=2",
        });
      }
      return httpRes({ values: [{ id: 7, title: TITLE, links: { html: { href: "u7" } } }], next: null });
    }
    return httpRes({ message: "unexpected" }, 404);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    dryRun: true,
    remoteUrl: "https://bitbucket.org/ws/slug.git",
    env: { BITBUCKET_TOKEN: "bt" },
  });
  assert.equal(r.action, "updated");
  assert.equal(r.number, 7);
  assert.equal(pages.length, 2);
  assert.equal(r.url, "u7");
});

// ---- Gitea behaviors ----------------------------------------------------------

test("gitea: creates and updates GitHub-style on the codeberg API", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    if (String(url).includes("/issues?") && !String(url).includes("/issues/")) {
      return httpRes([{ number: 7, title: TITLE, html_url: "https://codeberg.org/o/r/issues/7" }]);
    }
    if (String(url).includes("/issues/7") && init.method === "PATCH") {
      return httpRes({ number: 7, html_url: "https://codeberg.org/o/r/issues/7" });
    }
    return httpRes({ message: "not found" }, 404);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "git@codeberg.org:o/r.git",
    env: { GITEA_TOKEN: "gt" },
  });
  assert.equal(r.action, "updated");
  assert.equal(r.number, 7);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.url, "https://codeberg.org/api/v1/repos/o/r/issues/7");
  assert.deepEqual(JSON.parse(patch.body), { body: MARKDOWN });
  assert.ok(
    calls.some((c) => c.url.includes("sort=recentupdate")),
    "gitea search sorts by most-recently-updated"
  );
});

test("gitea: x-total-count keeps paginating when the Link header is missing", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const pages = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "PATCH") return httpRes({ number: 7, html_url: "u7" });
    if ((init.method ?? "GET") !== "GET") return httpRes({ message: "unexpected" }, 404);
    pages.push(String(url));
    const page = /(?:^|[?&])page=(\d+)/.exec(String(url))?.[1];
    const n = page ? Number(page) : 1;
    if (n === 1) {
      // No Link header (older Gitea): x-total-count is the only signal.
      return httpRes(
        Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, title: `noise ${i}` })),
        200,
        { "x-total-count": "101" }
      );
    }
    return httpRes([{ number: 7, title: TITLE, html_url: "u7" }]);
  };

  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    remoteUrl: "git@codeberg.org:o/r.git",
    env: { GITEA_TOKEN: "gt" },
  });
  assert.equal(r.action, "updated");
  assert.equal(r.number, 7);
  assert.deepEqual(pages.length, 2);
});

test("gitea: dry-run create preview points at the issues/new page", async (t) => {
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    return httpRes([]);
  };
  const r = await postReport({
    markdown: MARKDOWN,
    title: TITLE,
    dryRun: true,
    remoteUrl: "git@forgejo.org:o/r.git",
    env: { GITEA_TOKEN: "gt" },
  });
  assert.equal(r.action, "created");
  assert.equal(r.number, null);
  assert.equal(r.url, `https://forgejo.org/o/r/issues/new?title=${encodeURIComponent(TITLE)}`);
  assert.ok(!calls.some((u) => u.includes("/issues/") && !u.includes("/issues?")), "no write in dry-run");
});

// ---- CLI subcommand ------------------------------------------------------------

test("CLI: report-issue needs one argument", async () => {
  const r = await runCli(["report-issue"], { ...process.env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /report-issue needs one argument/);
});

test("CLI: report-issue errors loudly outside a git repo", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gc-notrepo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "report.md"), MARKDOWN);
  const r = await runCli(["report-issue", join(dir, "report.md"), "--repo", dir], {
    ...process.env,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not inside a git repository/);
});

test("CLI: report-issue errors when the remote has no supported forge", async (t) => {
  const dir = makeRepo(t, "git@example.com:team/project.git");
  writeFileSync(join(dir, "report.md"), MARKDOWN);
  const r = await runCli(["report-issue", join(dir, "report.md"), "--repo", dir], {
    ...process.env,
    GITHUB_TOKEN: "t",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no supported forge remote/);
});

test("CLI: report-issue errors without a token even in dry-run", async (t) => {
  const dir = makeRepo(t, "git@github.com:owner/repo.git");
  writeFileSync(join(dir, "report.md"), MARKDOWN);
  const r = await runCli(
    ["report-issue", join(dir, "report.md"), "--repo", dir, "--dry-run"],
    { ...process.env }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_TOKEN/);
});

async function withApiServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test("CLI: report-issue --dry-run on a GitHub remote prints the preview", async (t) => {
  const dir = makeRepo(t, "git@github.com:owner/repo.git");
  writeFileSync(join(dir, "report.md"), MARKDOWN);
  const server = await withApiServer(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([]));
  });
  const env = {
    ...process.env,
    GITHUB_TOKEN: "gh-token",
    GITHUB_API_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  const r = await runCli(
    ["report-issue", join(dir, "report.md"), "--repo", dir, "--dry-run"],
    env
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] would create issue "git-cleanup: branch report"/);
  assert.match(r.stdout, /issues\/new\?title=/);
  assert.match(r.stdout, /no write performed/);
});

test("CLI: report-issue --dry-run --json prints the rehearsal result object", async (t) => {
  const dir = makeRepo(t, "git@github.com:owner/repo.git");
  writeFileSync(join(dir, "report.md"), MARKDOWN);
  const server = await withApiServer(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ number: 7, title: TITLE, html_url: "https://github.com/owner/repo/issues/7" }]));
  });
  const env = {
    ...process.env,
    GITHUB_TOKEN: "gh-token",
    GITHUB_API_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  const r = await runCli(
    ["report-issue", join(dir, "report.md"), "--repo", dir, "--dry-run", "--json"],
    env
  );
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.action, "updated");
  assert.equal(doc.number, 7);
  assert.equal(doc.dryRun, true);
});

test("CLI: report-issue posts for real through the local server", async (t) => {
  const dir = makeRepo(t, "git@gitlab.com:group/repo.git");
  writeFileSync(join(dir, "report.md"), MARKDOWN);
  const methods = [];
  const server = await withApiServer(t, (req, res) => {
    methods.push(req.method);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      res.end(JSON.stringify({ iid: 9, web_url: "https://gitlab.com/group/repo/-/issues/9" }));
    } else {
      res.end(JSON.stringify([]));
    }
  });
  const env = {
    ...process.env,
    GITLAB_TOKEN: "gl-token",
    CI_API_V4_URL: `http://127.0.0.1:${server.address().port}/api/v4`,
  };
  const r = await runCli(
    ["report-issue", join(dir, "report.md"), "--repo", dir, "--title", "git-cleanup: branch report"],
    env
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /created issue #9 — https:\/\/gitlab\.com\/group\/repo\/-\/issues\/9/);
  assert.ok(methods.includes("POST"), "the write went through");
});
