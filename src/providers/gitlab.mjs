// GitLab forge provider (see src/forge.mjs for the provider contract).
// Reads merge requests via the GitLab REST API with a GITLAB_TOKEN env var:
//   - gitlab.com        -> https://gitlab.com/api/v4
//   - self-hosted      -> https://<host>/api/v4 (standard install layout)
//   - override both    -> GITLAB_API_BASE env var
// There is no CLI fast path (unlike GitHub's `gh`); when no token is set,
// PRs are simply not tracked and cleanup falls back to pure git detection.

import { spawnSync } from "node:child_process";
import { daysFromNowIso } from "../util.mjs";

export class PRBackendError extends Error {}

const API_V4 = "/api/v4";

/** API base for a host (gitlab.com or a self-hosted instance). */
function apiBaseFor(host) {
  return process.env.GITLAB_API_BASE || `https://${host}${API_V4}`;
}

/**
 * Parse a GitLab remote URL, or null.
 * Returns { owner, repo, host, apiBase } — owner is the full namespace path
 * (nested groups joined with "/"), repo the project name.
 */
export function parseGitLabRemote(url) {
  if (!url) return null;
  let u = url.trim();
  if (u.includes("://")) {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // drop scheme (https://, ssh://)
  }
  u = u.replace(/^[^@/]+@/, ""); // drop userinfo (git@host:path, user@https)
  const m = /^([^/:]+)[:/](.+)$/.exec(u);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!host.includes("gitlab")) return null;
  const path = m[2].replace(/\.git$/, "").replace(/\/+$/, "");
  if (!path) return null;
  const segs = path.split("/");
  const repo = segs.pop();
  const owner = segs.join("/");
  if (!repo) return null;
  return { owner, repo, host, apiBase: apiBaseFor(host) };
}

/** Find the first GitLab remote of a repo. Returns {name, owner, repo, host, apiBase} or null. */
function findGitLabRemote(cwd, remotes) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (!r.status) {
      const parsed = parseGitLabRemote((r.stdout || "").trim());
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
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `${apiBase}/projects/${project}/merge_requests?state=all&per_page=100&page=${page}`,
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
    if (items.length < 100) break;
  }
  return out;
}

/**
 * Load every merge request for the repo, keyed by source branch name.
 * Returns { provider, source, repo, prs: Map<headRef, PR[]>, error }
 *  - provider: "gitlab"
 *  - source: "api" | "none"
 *  - repo carries { owner, repo, host, apiBase } for downstream use.
 */
async function loadPRs({ cwd, remotes, track }) {
  if (!track) {
    return { provider: "gitlab", source: "none", repo: null, prs: new Map(), error: null };
  }
  const glRemote = findGitLabRemote(cwd, remotes);
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
  try {
    raw = await fetchApiMrs(owner, repo, apiBase, token);
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
  return { provider: "gitlab", source: "api", repo: repoInfo, prs, error: null };
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
  const put = await fetch(`${apiBase}/projects/${project}/merge_requests/${pr.number}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ state_event: "close" }),
  });
  if (!put.ok) {
    throw new PRBackendError(`GitLab API ${put.status}: ${(await put.text()).slice(0, 300)}`);
  }
  if (comment) {
    const post = await fetch(
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

/** GitLab implementation of the forge provider contract. */
export const gitlabProvider = {
  id: "gitlab",
  parseRemote: parseGitLabRemote,
  findRemote: findGitLabRemote,
  loadPRs,
  closePR,
};