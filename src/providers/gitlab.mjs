// GitLab forge provider (see src/forge.mjs for the provider contract).
// Reads merge requests via the GitLab REST API with a GITLAB_TOKEN env var:
//   - gitlab.com        -> https://gitlab.com/api/v4
//   - self-hosted      -> https://<host>/api/v4 (standard install layout)
//   - override both    -> GITLAB_API_BASE env var
// There is no CLI fast path (unlike GitHub's `gh`); when no token is set,
// PRs are simply not tracked and cleanup falls back to pure git detection.

import { spawnSync } from "node:child_process";
import { apiFetch, daysFromNowIso, fetchWithTimeout, ForgeError } from "../util.mjs";

export class PRBackendError extends Error {}

const API_V4 = "/api/v4";
const REST_PER_PAGE = 100;
// Safety cap on pagination: beyond this many pages the MR list is truncated
// and the run reports `truncated: true` instead of silently judging branches
// against an incomplete MR picture.
const REST_MAX_PAGES = 20; // 2,000 merge requests

/** API base for a host (gitlab.com or a self-hosted instance). */
function apiBaseFor(host) {
  return process.env.GITLAB_API_BASE || `https://${host}${API_V4}`;
}

/**
 * Parse a GitLab remote URL, or null.
 * Returns { owner, repo, host, apiBase } — owner is the full namespace path
 * (nested groups joined with "/"), repo the project name.
 * `hostMap` is the `forge.hosts` config: hosts claimed there are accepted
 * even when "gitlab" is not in the hostname (custom-domain instances).
 */
export function parseGitLabRemote(url, hostMap = {}) {
  if (!url) return null;
  let u = url.trim();
  if (u.includes("://")) {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // drop scheme (https://, ssh://)
  }
  u = u.replace(/^[^@/]+@/, ""); // drop userinfo (git@host:path, user@https)
  // Optional :port (ssh://git@host:2222/...) must not leak into the path.
  const m = /^([^/:\s]+)(?::\d+)?[:/](.+)$/.exec(u);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!host.includes("gitlab") && hostMap[host] !== "gitlab") return null;
  const path = m[2].replace(/\.git$/, "").replace(/\/+$/, "");
  if (!path) return null;
  const segs = path.split("/");
  const repo = segs.pop();
  const owner = segs.join("/");
  if (!repo) return null;
  return { owner, repo, host, apiBase: apiBaseFor(host) };
}

/** Find the first GitLab remote of a repo. Returns {name, owner, repo, host, apiBase} or null. */
function findGitLabRemote(cwd, remotes, hostMap = {}) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (!r.status) {
      const parsed = parseGitLabRemote((r.stdout || "").trim(), hostMap);
      if (parsed) return { name, ...parsed };
    }
  }
  return null;
}

/** Map a GitLab MR to the common PR shape (see forge.mjs). */
function normalizeMr(p, apiBase) {
  return {
    number: p.iid, // project-scoped MR number
    title: p.title ?? "",
    url: p.web_url ?? "",
    headRef: p.source_branch ?? "",
    isDraft: Boolean(p.draft),
    state: p.state === "merged" ? "merged" : p.state === "closed" ? "closed" : "open",
    updatedAt: p.updated_at,
    mergedAt: p.merged_at ?? null,
    apiBase, // internal: required to close later
  };
}

async function fetchApiMrs(owner, repo, apiBase, token) {
  const project = encodeURIComponent(`${owner}/${repo}`);
  const out = [];
  let truncated = false;
  let page = 1;
  for (;;) {
    const res = await fetchWithTimeout(
      `${apiBase}/projects/${project}/merge_requests?state=all&per_page=${REST_PER_PAGE}&page=${page}`,
      {
        headers: {
          "PRIVATE-TOKEN": token,
          "User-Agent": "git-cleanup",
        },
      }
    );
    if (!res.ok) {
      throw new PRBackendError(`GitLab API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const p of items) out.push(p);
    // Follow pagination while the API advertises a next page; stop early (and
    // say so) once the safety cap is reached. Falls back to stopping when a
    // page comes back short, so stubs / header-less proxies still terminate.
    if (!res.headers?.get?.("x-next-page")) break;
    if (page >= REST_MAX_PAGES) {
      truncated = true;
      break;
    }
    page += 1;
  }
  return { mrs: out, truncated };
}

/**
 * Load every merge request for the repo, keyed by source branch name.
 * Returns { provider, source, repo, prs: Map<headRef, PR[]>, error }
 *  - provider: "gitlab"
 *  - source: "api" | "none"
 *  - repo carries { owner, repo, host, apiBase } for downstream use.
 */
async function loadPRs({ cwd, remotes, track, hostMap = {} }) {
  if (!track) {
    return { provider: "gitlab", source: "none", repo: null, prs: new Map(), error: null };
  }
  const glRemote = findGitLabRemote(cwd, remotes, hostMap);
  if (!glRemote) {
    return {
      provider: "gitlab",
      source: "none",
      repo: null,
      prs: new Map(),
      error: "no GitLab remote found",
    };
  }
  const { owner, repo, host, apiBase } = glRemote;
  const repoInfo = { owner, repo, host, apiBase };

  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    return {
      provider: "gitlab",
      source: "none",
      repo: repoInfo,
      prs: new Map(),
      error: "PR lookup unavailable: no GITLAB_TOKEN set.",
    };
  }

  let raw;
  let truncated = false;
  try {
    ({ mrs: raw, truncated } = await fetchApiMrs(owner, repo, apiBase, token));
  } catch (err) {
    return {
      provider: "gitlab",
      source: "none",
      repo: repoInfo,
      prs: new Map(),
      error: `PR lookup failed: ${err.message}`,
    };
  }

  const prs = new Map();
  const now = Date.now();
  for (const p of raw) {
    const mr = normalizeMr(p, apiBase);
    if (!mr.headRef) continue;
    mr.ageDays = daysFromNowIso(mr.updatedAt, new Date(now));
    const list = prs.get(mr.headRef) ?? [];
    list.push(mr);
    prs.set(mr.headRef, list);
  }
  for (const list of prs.values()) {
    list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  return { provider: "gitlab", source: "api", repo: repoInfo, prs, error: null, truncated };
}

/** Close one MR via the GitLab API (state_event close, optional note). */
async function closePR({ owner, repo, source, pr, comment }) {
  const apiBase = pr?.apiBase ?? apiBaseFor("gitlab.com");
  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    throw new PRBackendError("no GITLAB_TOKEN set to close merge requests");
  }
  const project = encodeURIComponent(`${owner}/${repo}`);
  const headers = {
    "PRIVATE-TOKEN": token,
    "User-Agent": "git-cleanup",
    "Content-Type": "application/json",
  };
  const put = await fetchWithTimeout(`${apiBase}/projects/${project}/merge_requests/${pr.number}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ state_event: "close" }),
  });
  if (!put.ok) {
    throw new PRBackendError(`GitLab API ${put.status}: ${(await put.text()).slice(0, 300)}`);
  }
  if (comment) {
    const post = await fetchWithTimeout(
      `${apiBase}/projects/${project}/merge_requests/${pr.number}/notes`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body: comment }),
      }
    );
    if (!post.ok) {
      throw new PRBackendError(`comment failed: GitLab API ${post.status}`);
    }
  }
  return null;
}

// ---- issues capability (report-issue) --------------------------------------
// Keeps ONE issue with a fixed title current on this forge. The dedup search
// is narrowed with `search=` + `in=title` so the existing report issue is
// found even when the project has more open issues than the pagination cap
// covers (a fixed page-walk would silently duplicate it).

const ISSUE_PER_PAGE = 100;
const ISSUE_MAX_PAGES = 5; // 500 issues max searched per run
const LABEL = "GitLab";

export const issues = {
  /** Token + endpoints for report-issue on this forge (throws ForgeError). */
  context(remoteUrl, env = process.env, hostMap = {}) {
    const p = parseGitLabRemote(remoteUrl, hostMap);
    if (!p) throw new ForgeError(`cannot parse GitLab remote: ${remoteUrl}`);
    const token = env.GITLAB_TOKEN || env.CI_JOB_TOKEN;
    if (!token) {
      throw new ForgeError(
        "no token available: set GITLAB_TOKEN (project access token with `api` scope), or run inside a GitLab pipeline whose job token has Issues API write access (not the default)"
      );
    }
    return {
      forge: "gitlab",
      apiBase: env.GITLAB_API_BASE || env.CI_API_V4_URL || p.apiBase,
      webBase: `https://${p.host}`,
      owner: p.owner,
      repo: p.repo,
      project: `${p.owner}/${p.repo}`, // nested groups included
      headers: env.GITLAB_TOKEN
        ? { "PRIVATE-TOKEN": env.GITLAB_TOKEN }
        : { "JOB-TOKEN": env.CI_JOB_TOKEN },
    };
  },

  /** The open issue with exactly `title`, or null. */
  async findIssue(ctx, title) {
    const project = encodeURIComponent(ctx.project);
    for (let page = 1; page <= ISSUE_MAX_PAGES; page++) {
      const res = await apiFetch(
        `${ctx.apiBase}/projects/${project}/issues?state=opened&scope=all&search=${encodeURIComponent(title)}&in=title&per_page=${ISSUE_PER_PAGE}&page=${page}`,
        { headers: ctx.headers },
        LABEL
      );
      const items = await res.json();
      if (!Array.isArray(items)) break;
      for (const it of items) {
        if (it.title === title) return { title: it.title, number: it.iid, url: it.web_url };
      }
      if (!res.headers?.get?.("x-next-page")) break;
    }
    return null;
  },

  async createIssue(ctx, title, body) {
    const project = encodeURIComponent(ctx.project);
    const res = await apiFetch(
      `${ctx.apiBase}/projects/${project}/issues`,
      {
        method: "POST",
        headers: { ...ctx.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ title, description: body }),
      },
      LABEL
    );
    const it = await res.json();
    return { number: it.iid, url: it.web_url };
  },

  async updateIssue(ctx, number, body) {
    const project = encodeURIComponent(ctx.project);
    const res = await apiFetch(
      `${ctx.apiBase}/projects/${project}/issues/${number}`,
      {
        method: "PUT",
        headers: { ...ctx.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ description: body }),
      },
      LABEL
    );
    const it = await res.json();
    return { number: it.iid, url: it.web_url };
  },

  /** Where a created issue would live — the openable create page. */
  previewUrl(ctx, title) {
    return `${ctx.webBase}/${ctx.owner}/${ctx.repo}/-/issues/new`;
  },
};

/** GitLab implementation of the forge provider contract. */
export const gitlabProvider = {
  id: "gitlab",
  parseRemote: parseGitLabRemote,
  findRemote: findGitLabRemote,
  loadPRs,
  closePR,
  issues,
};
