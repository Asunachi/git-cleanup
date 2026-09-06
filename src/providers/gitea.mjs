// Gitea forge provider (see src/forge.mjs for the provider contract).
//
// Gitea's REST API (v1) is deliberately GitHub-shaped, so this provider is
// the GitHub REST pattern pointed at Gitea hosts:
//   - pull request list:  GET  /api/v1/repos/{owner}/{repo}/pulls
//   - close:              PATCH /api/v1/repos/{owner}/{repo}/pulls/{number}
//   - comment:            POST  /api/v1/repos/{owner}/{repo}/issues/{number}/comments
//
// Known hosts (each resolves its own API base, override with GITEA_API_BASE):
//   - gitea.com      -> https://gitea.com/api/v1
//   - codeberg.org   -> https://codeberg.org/api/v1   (Codeberg runs Gitea)
//   - forgejo.org    -> https://forgejo.org/api/v1    (Forgejo is a Gitea fork)
// Auth is a GITEA_TOKEN env var sent as `Authorization: token <token>`.
//
// Self-hosted Gitea/Forgejo instances on arbitrary domains cannot be
// recognized by hostname (unlike GitLab, "gitea" is not in the host). The
// `forge.hosts` config claims them explicitly
// ({"git.internal": "gitea"}), deriving the API base https://<host>/api/v1
// (or GITEA_API_BASE when set).

import { spawnSync } from "node:child_process";
import { apiFetch, daysFromNowIso, fetchWithTimeout, ForgeError } from "../util.mjs";

export class PRBackendError extends Error {}

const API_V1 = "/api/v1";
const REST_PER_PAGE = 100;
// Safety cap on pagination: beyond this many pages the PR list is truncated
// and the run reports `truncated: true` instead of silently judging branches
// against an incomplete PR picture.
const REST_MAX_PAGES = 20; // 2,000 pull requests

/** Hosts this provider claims, and their default API bases. */
const HOSTS = {
  "gitea.com": "https://gitea.com",
  "codeberg.org": "https://codeberg.org",
  "forgejo.org": "https://forgejo.org",
};

function apiBaseFor(host) {
  // Known hosts have a fixed base; custom (forge.hosts-claimed) hosts derive
  // https://<host>/api/v1 — the standard Gitea install layout.
  return process.env.GITEA_API_BASE || `${HOSTS[host] ?? `https://${host}`}${API_V1}`;
}

/**
 * Parse a supported Gitea remote URL, or null.
 * Returns { owner, repo, host, apiBase }.
 * `hostMap` is the `forge.hosts` config: hosts claimed there are accepted
 * even when they are not one of the known Gitea-family domains.
 */
export function parseGiteaRemote(url, hostMap = {}) {
  if (!url) return null;
  let u = url.trim();
  u = u.replace(/^ssh:\/\//, ""); // ssh://git@host/owner/repo -> git@...
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // https://, git:// -> host/...
  const at = u.indexOf("@");
  if (at !== -1) u = u.slice(at + 1); // drop userinfo (git@host:path)
  // Optional :port (ssh://git@host:2222/...) must not leak into the path.
  const m = /^([^/:\s]+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(u);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!HOSTS[host] && hostMap[host] !== "gitea") return null;
  const owner = m[2];
  const repo = m[3].replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo, host, apiBase: apiBaseFor(host) };
}

/** Find the first supported Gitea remote of a repo. Returns {name, owner, repo, host, apiBase} or null. */
function findGiteaRemote(cwd, remotes, hostMap = {}) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (!r.status) {
      const parsed = parseGiteaRemote((r.stdout || "").trim(), hostMap);
      if (parsed) return { name, ...parsed };
    }
  }
  return null;
}

/** Map a Gitea pull request to the common PR shape (see forge.mjs). */
function normalizePr(p) {
  const merged = p.state === "closed" && Boolean(p.merged_at);
  return {
    number: p.number,
    title: p.title ?? "",
    url: p.html_url ?? "",
    headRef: p.head?.ref ?? "",
    isDraft: Boolean(p.draft),
    state: merged ? "merged" : p.state === "closed" ? "closed" : "open",
    updatedAt: p.updated_at,
    mergedAt: p.merged_at ?? null,
  };
}

/** rel="next" URL from a Link header, or null. */
function linkNext(header) {
  const m = /<([^>]+)>;\s*rel="?next"?/i.exec(header ?? "");
  return m ? m[1] : null;
}

/**
 * Fetch every pull request for the repo. Pagination follows the Link header
 * Gitea sends when more pages exist, with x-total-count as a fallback
 * signal. Returns { prs, truncated }.
 */
async function fetchApiPrs(owner, repo, apiBase, token) {
  const out = [];
  let truncated = false;
  let page = 1;
  const base =
    `${apiBase}/repos/${owner}/${repo}/pulls` +
    `?state=all&sort=recentupdate&limit=${REST_PER_PAGE}&page=`;
  for (;;) {
    const res = await fetchWithTimeout(`${base}${page}`, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "git-cleanup",
      },
    });
    if (!res.ok) {
      throw new PRBackendError(`Gitea API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const p of items) out.push(p);

    // Evidence that more pages exist: the Link header (Gitea sends it when
    // there is more than one page) or x-total-count saying we are short.
    const total = Number(res.headers?.get?.("x-total-count"));
    const hasMore =
      linkNext(res.headers?.get?.("link")) !== null ||
      (Number.isFinite(total) && out.length < total);
    if (!hasMore) break;
    if (page >= REST_MAX_PAGES) {
      truncated = true;
      break;
    }
    page += 1;
  }
  return { prs: out, truncated };
}

/**
 * Load every pull request for the repo, keyed by head branch name.
 * Returns { provider, source, repo, prs: Map<headRef, PR[]>, error, truncated }
 *  - provider: "gitea"
 *  - source: "api" | "none"
 */
async function loadPRs({ cwd, remotes, track, hostMap = {} }) {
  if (!track) {
    return { provider: "gitea", source: "none", repo: null, prs: new Map(), error: null };
  }
  const gRemote = findGiteaRemote(cwd, remotes, hostMap);
  if (!gRemote) {
    return {
      provider: "gitea",
      source: "none",
      repo: null,
      prs: new Map(),
      error: "no Gitea remote found",
    };
  }
  const { owner, repo, host, apiBase } = gRemote;
  const repoInfo = { owner, repo, host, apiBase };

  const token = process.env.GITEA_TOKEN;
  if (!token) {
    return {
      provider: "gitea",
      source: "none",
      repo: repoInfo,
      prs: new Map(),
      error: "PR lookup unavailable: no GITEA_TOKEN set.",
    };
  }

  let raw;
  let truncated = false;
  try {
    ({ prs: raw, truncated } = await fetchApiPrs(owner, repo, apiBase, token));
  } catch (err) {
    return {
      provider: "gitea",
      source: "none",
      repo: repoInfo,
      prs: new Map(),
      error: `PR lookup failed: ${err.message}`,
    };
  }

  const prs = new Map();
  const now = Date.now();
  for (const p of raw) {
    const pr = normalizePr(p);
    if (!pr.headRef) continue;
    pr.ageDays = daysFromNowIso(pr.updatedAt, new Date(now));
    const list = prs.get(pr.headRef) ?? [];
    list.push(pr);
    prs.set(pr.headRef, list);
  }
  for (const list of prs.values()) {
    list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  return { provider: "gitea", source: "api", repo: repoInfo, prs, error: null, truncated };
}

/** Close one pull request via the API (PATCH state: closed), optionally with a comment. */
async function closePR({ owner, repo, source, pr, comment }) {
  const token = process.env.GITEA_TOKEN;
  if (!token) {
    throw new PRBackendError("no GITEA_TOKEN set to close pull requests");
  }
  const apiBase = pr?.apiBase ?? apiBaseFor("gitea.com");
  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "git-cleanup",
    "Content-Type": "application/json",
  };
  const patch = await fetchWithTimeout(`${apiBase}/repos/${owner}/${repo}/pulls/${pr.number}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: "closed" }),
  });
  if (!patch.ok) {
    throw new PRBackendError(`Gitea API ${patch.status}: ${(await patch.text()).slice(0, 300)}`);
  }
  if (comment) {
    const post = await fetchWithTimeout(
      `${apiBase}/repos/${owner}/${repo}/issues/${pr.number}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body: comment }),
      }
    );
    if (!post.ok) {
      throw new PRBackendError(`comment failed: Gitea API ${post.status}`);
    }
  }
  return null;
}

// ---- issues capability (report-issue) --------------------------------------
// Keeps ONE issue with a fixed title current on this forge. The dedup search
// sorts most-recently-updated first (mirrors the provider's pull sort) and
// paginates via Link header with x-total-count as a fallback, exactly like
// the PR list — so older Gitea servers that omit Link are still walked.

const ISSUE_LIMIT = 100;
const ISSUE_MAX_PAGES = 5; // 500 issues max searched per run
const LABEL = "Gitea";

export const issues = {
  /** Token + endpoints for report-issue on this forge (throws ForgeError). */
  context(remoteUrl, env = process.env, hostMap = {}) {
    const p = parseGiteaRemote(remoteUrl, hostMap);
    if (!p) throw new ForgeError(`cannot parse Gitea remote: ${remoteUrl}`);
    if (!env.GITEA_TOKEN) throw new ForgeError("no token available: set GITEA_TOKEN");
    return {
      forge: "gitea",
      // p.apiBase already honors a process-env GITEA_API_BASE; env wins first
      // so an explicit env override (tests, embedding) works like the others.
      apiBase: env.GITEA_API_BASE || p.apiBase,
      webBase: `https://${p.host}`,
      owner: p.owner,
      repo: p.repo,
      headers: { Authorization: `token ${env.GITEA_TOKEN}` },
    };
  },

  /** The open issue with exactly `title`, or null. */
  async findIssue(ctx, title) {
    let fetched = 0;
    for (let page = 1; page <= ISSUE_MAX_PAGES; page++) {
      const res = await apiFetch(
        `${ctx.apiBase}/repos/${ctx.owner}/${ctx.repo}/issues?state=open&type=issues&sort=recentupdate&limit=${ISSUE_LIMIT}&page=${page}`,
        { headers: ctx.headers },
        LABEL
      );
      const items = await res.json();
      if (!Array.isArray(items)) break;
      for (const it of items) {
        fetched++;
        if (it.title === title) return { title: it.title, number: it.number, url: it.html_url };
      }
      // Evidence that more pages exist: Link header, or x-total-count saying
      // we are short (older Gitea may omit Link) — mirrors the PR list.
      const total = Number(res.headers?.get?.("x-total-count"));
      const hasMore =
        /rel="?next"?/.test(res.headers?.get?.("link") ?? "") ||
        (Number.isFinite(total) && fetched < total);
      if (!hasMore) break;
    }
    return null;
  },

  async createIssue(ctx, title, body) {
    const res = await apiFetch(
      `${ctx.apiBase}/repos/${ctx.owner}/${ctx.repo}/issues`,
      {
        method: "POST",
        headers: { ...ctx.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      },
      LABEL
    );
    const it = await res.json();
    return { number: it.number, url: it.html_url };
  },

  async updateIssue(ctx, number, body) {
    const res = await apiFetch(
      `${ctx.apiBase}/repos/${ctx.owner}/${ctx.repo}/issues/${number}`,
      {
        method: "PATCH",
        headers: { ...ctx.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
      LABEL
    );
    const it = await res.json();
    return { number: it.number, url: it.html_url };
  },

  /** Where a created issue would live — the openable create page. */
  previewUrl(ctx, title) {
    return `${ctx.webBase}/${ctx.owner}/${ctx.repo}/issues/new?title=${encodeURIComponent(title)}`;
  },
};

/** Gitea implementation of the forge provider contract. */
export const giteaProvider = {
  id: "gitea",
  parseRemote: parseGiteaRemote,
  findRemote: findGiteaRemote,
  loadPRs,
  closePR,
  issues,
};
