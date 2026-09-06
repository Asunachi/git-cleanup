// Bitbucket forge provider (see src/forge.mjs for the provider contract).
// Reads pull requests via the Bitbucket Cloud REST API (v2) with a
// BITBUCKET_TOKEN env var:
//   - bitbucket.org -> https://api.bitbucket.org/2.0
//   - override      -> BITBUCKET_API_BASE env var
// Closing a pull request maps to the API's "decline" action (the standard
// way to close one without merging), optionally with a comment.
//
// Bitbucket Server (self-hosted, now "Data Center") exposes a different
// REST API and has its own provider (src/providers/bitbucket-server.mjs);
// this module claims bitbucket.org only.

import { spawnSync } from "node:child_process";
import { apiFetch, daysFromNowIso, fetchWithTimeout, ForgeError } from "../util.mjs";

export class PRBackendError extends Error {}

const API_V2 = "https://api.bitbucket.org/2.0";
const REST_PER_PAGE = 100;
// Safety cap on pagination: beyond this many pages the PR list is truncated
// and the run reports `truncated: true` instead of silently judging branches
// against an incomplete PR picture.
const REST_MAX_PAGES = 20; // 2,000 pull requests

function apiBase() {
  return process.env.BITBUCKET_API_BASE || API_V2;
}

/**
 * Parse a bitbucket.org remote URL, or null.
 * Returns { owner, repo } — owner is the workspace, repo the repository slug
 * (both single path segments on Bitbucket Cloud).
 */
export function parseBitbucketRemote(url) {
  if (!url) return null;
  let u = url.trim();
  u = u.replace(/^ssh:\/\//, ""); // ssh://git@bitbucket.org/ws/repo -> git@...
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // https://, git:// -> host/...
  const at = u.indexOf("@");
  if (at !== -1) u = u.slice(at + 1); // drop userinfo (git@host:path)
  const m = /^bitbucket\.org[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(u);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Find the first Bitbucket remote of a repo. Returns {name, owner, repo} or null. */
function findBitbucketRemote(cwd, remotes) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (!r.status) {
      const parsed = parseBitbucketRemote((r.stdout || "").trim());
      if (parsed) return { name, ...parsed };
    }
  }
  return null;
}

/** Map a Bitbucket pull request to the common PR shape (see forge.mjs). */
function normalizePr(p) {
  const state = p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "open" : "closed";
  return {
    number: p.id,
    title: p.title ?? "",
    url: p.links?.html?.href ?? "",
    headRef: p.source?.branch?.name ?? "",
    isDraft: Boolean(p.draft),
    state, // DECLINED / SUPERSEDED count as closed-without-merge
    updatedAt: p.updated_on ?? null,
    mergedAt: state === "merged" ? (p.closed_on ?? null) : null,
  };
}

/**
 * Fetch every pull request for the repo, following the `next` pagination URL
 * the API embeds in the response body. Returns { prs, truncated }.
 */
async function fetchApiPrs(owner, repo, token) {
  const out = [];
  let truncated = false;
  const project = `${owner}/${repo}`;
  let url =
    `${apiBase()}/repositories/${project}/pullrequests` +
    "?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED" +
    `&pagelen=${REST_PER_PAGE}&sort=-updated_on`;
  for (let page = 1; page <= REST_MAX_PAGES; page++) {
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "git-cleanup",
      },
    });
    if (!res.ok) {
      throw new PRBackendError(`Bitbucket API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    const items = body?.values;
    if (!Array.isArray(items)) break;
    for (const p of items) out.push(p);
    // Bitbucket paginates with a full `next` URL inside the response body.
    if (typeof body.next !== "string" || body.next === "" || items.length === 0) break;
    if (page >= REST_MAX_PAGES) {
      truncated = true;
      break;
    }
    url = body.next;
  }
  return { prs: out, truncated };
}

/**
 * Load every pull request for the repo, keyed by source branch name.
 * Returns { provider, source, repo, prs: Map<headRef, PR[]>, error, truncated }
 *  - provider: "bitbucket"
 *  - source: "api" | "none"
 */
async function loadPRs({ cwd, remotes, track }) {
  if (!track) {
    return { provider: "bitbucket", source: "none", repo: null, prs: new Map(), error: null };
  }
  const bbRemote = findBitbucketRemote(cwd, remotes);
  if (!bbRemote) {
    return {
      provider: "bitbucket",
      source: "none",
      repo: null,
      prs: new Map(),
      error: "no Bitbucket remote found",
    };
  }
  const { owner, repo } = bbRemote;
  const repoInfo = { owner, repo };

  const token = process.env.BITBUCKET_TOKEN;
  if (!token) {
    return {
      provider: "bitbucket",
      source: "none",
      repo: repoInfo,
      prs: new Map(),
      error: "PR lookup unavailable: no BITBUCKET_TOKEN set.",
    };
  }

  let raw;
  let truncated = false;
  try {
    ({ prs: raw, truncated } = await fetchApiPrs(owner, repo, token));
  } catch (err) {
    return {
      provider: "bitbucket",
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
  return { provider: "bitbucket", source: "api", repo: repoInfo, prs, error: null, truncated };
}

/** Close one pull request via the API (decline), optionally with a comment. */
async function closePR({ owner, repo, source, pr, comment }) {
  const token = process.env.BITBUCKET_TOKEN;
  if (!token) {
    throw new PRBackendError("no BITBUCKET_TOKEN set to close pull requests");
  }
  const base = `${apiBase()}/repositories/${owner}/${repo}/pullrequests/${pr.number}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "git-cleanup",
    "Content-Type": "application/json",
  };
  const decline = await fetchWithTimeout(`${base}/decline`, { method: "POST", headers });
  if (!decline.ok) {
    throw new PRBackendError(`Bitbucket API ${decline.status}: ${(await decline.text()).slice(0, 300)}`);
  }
  if (comment) {
    const post = await fetchWithTimeout(`${base}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: { raw: comment } }),
    });
    if (!post.ok) {
      throw new PRBackendError(`comment failed: Bitbucket API ${post.status}`);
    }
  }
  return null;
}

// ---- issues capability (report-issue) --------------------------------------
// Keeps ONE issue with a fixed title current on this forge. The dedup search
// sorts most-recently-updated first so a weekly-updated report issue
// surfaces on page 1 even on busy workspaces.

const ISSUE_PAGELEN = 100;
const ISSUE_MAX_PAGES = 5; // 500 issues max searched per run
const LABEL = "Bitbucket";

export const issues = {
  /** Token + endpoints for report-issue on this forge (throws ForgeError). */
  context(remoteUrl, env = process.env) {
    const p = parseBitbucketRemote(remoteUrl);
    if (!p) throw new ForgeError(`cannot parse Bitbucket remote: ${remoteUrl}`);
    if (!env.BITBUCKET_TOKEN) throw new ForgeError("no token available: set BITBUCKET_TOKEN");
    return {
      forge: "bitbucket",
      apiBase: env.BITBUCKET_API_BASE || "https://api.bitbucket.org/2.0",
      webBase: "https://bitbucket.org",
      owner: p.owner,
      repo: p.repo,
      headers: { Authorization: `Bearer ${env.BITBUCKET_TOKEN}` },
    };
  },

  /** The open issue with exactly `title`, or null. */
  async findIssue(ctx, title) {
    let url =
      `${ctx.apiBase}/repositories/${ctx.owner}/${ctx.repo}/issues` +
      `?state=OPEN&sort=-updated_on&pagelen=${ISSUE_PAGELEN}&page=1`;
    for (let page = 1; page <= ISSUE_MAX_PAGES; page++) {
      const res = await apiFetch(url, { headers: ctx.headers }, LABEL);
      const body = await res.json();
      const items = body?.values;
      if (!Array.isArray(items)) break;
      for (const it of items) {
        if (it.title === title) return { title: it.title, number: it.id, url: it.links?.html?.href };
      }
      // Bitbucket paginates with a full `next` URL embedded in the body.
      if (typeof body.next !== "string" || body.next === "" || items.length === 0) break;
      url = body.next;
    }
    return null;
  },

  async createIssue(ctx, title, body) {
    const res = await apiFetch(
      `${ctx.apiBase}/repositories/${ctx.owner}/${ctx.repo}/issues`,
      {
        method: "POST",
        headers: { ...ctx.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ title, content: { raw: body } }),
      },
      LABEL
    );
    const it = await res.json();
    return { number: it.id, url: it.links?.html?.href };
  },

  async updateIssue(ctx, number, body) {
    const res = await apiFetch(
      `${ctx.apiBase}/repositories/${ctx.owner}/${ctx.repo}/issues/${number}`,
      {
        method: "PUT",
        headers: { ...ctx.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ content: { raw: body } }),
      },
      LABEL
    );
    const it = await res.json();
    return { number: it.id, url: it.links?.html?.href };
  },

  /** Where a created issue would live — the openable create page. */
  previewUrl(ctx, title) {
    return `${ctx.webBase}/${ctx.owner}/${ctx.repo}/issues/new`;
  },
};

/** Bitbucket implementation of the forge provider contract. */
export const bitbucketProvider = {
  id: "bitbucket",
  parseRemote: parseBitbucketRemote,
  findRemote: findBitbucketRemote,
  loadPRs,
  closePR,
  issues,
};
