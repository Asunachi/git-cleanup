// Bitbucket Server (now "Bitbucket Data Center") forge provider — the
// self-hosted sibling of src/providers/bitbucket.mjs (Cloud). Bitbucket
// Server exposes a DIFFERENT REST API than Cloud, so it gets its own
// provider behind the same forge contract:
//
//   - API:     /rest/api/1.0 (Cloud is api.bitbucket.org/2.0)
//   - list:    GET  /rest/api/1.0/projects/{key}/repos/{slug}/pull-requests
//              ?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED
//              &limit=100&start=0   -> { values, isLastPage, nextPageStart }
//   - decline: POST .../pull-requests/{id}/decline?version={version}
//   - comment: POST .../pull-requests/{id}/comments   { "text": "..." }
//   - dates:   epoch MILLISECONDS (Cloud sends ISO strings)
//   - refs:    fromRef.displayId (Cloud nests under source.branch.name)
//   - no drafts: a Bitbucket Server PR is either open or not
//
// Projects have exactly TWO path segments on the server — a project key and
// a repo slug (no nested namespaces) — so a remote parses to {key}/{slug}.
// Git clone URLs look like https://<host>/scm/PROJ/repo.git (or
// ssh://git@<host>:7999/PROJ/repo.git); the API base derives from the host
// as https://<host>/rest/api/1.0.
//
// Claiming: a hostname containing "bitbucket" (other than bitbucket.org,
// which is Cloud) is assumed to be a Server instance — bitbucket.corp.com,
// bitbucket.example.org — and arbitrary domains can be claimed explicitly
// via the forge.hosts config: { "stash.internal": "bitbucket-server" }.
//
// Auth is a BITBUCKET_TOKEN env var sent as `Authorization: Bearer` (a
// Data Center personal access token, or an HTTP access token).
//
// Bitbucket Server has NO native issue tracker (that is Jira's job), so
// this provider deliberately implements no `issues` capability:
// `git-cleanup report-issue` on a Server remote fails loudly — posting
// without knowing where is never silently skipped.
//
// If Server's REST API ever grows an issue tracker, add the capability
// here; the report-issue command already handles it generically.

import { spawnSync } from "node:child_process";
import { daysFromNowIso, fetchWithTimeout } from "../util.mjs";

export class PRBackendError extends Error {}

const REST_PER_PAGE = 100;
// Safety cap on pagination: beyond this many pages the PR list is truncated
// and the run reports `truncated: true` instead of silently judging branches
// against an incomplete PR picture.
const REST_MAX_PAGES = 20; // 2,000 pull requests

function apiBaseFor(host) {
  return process.env.BITBUCKET_API_BASE || `https://${host}/rest/api/1.0`;
}

/**
 * Parse a Bitbucket Server remote URL, or null.
 * Returns { owner, repo, host, apiBase } — owner is the PROJECT KEY and repo
 * the repository slug (Bitbucket Server projects have exactly one level).
 * `hostMap` is the `forge.hosts` config: hosts claimed there are accepted
 * even when "bitbucket" is not in the hostname (custom-domain instances).
 * Accepts every git clone shape the server produces: https with an /scm/
 * prefix, plain host/key/repo, ssh:// with a port, and scp-like host:key.
 */
export function parseBitbucketServerRemote(url, hostMap = {}) {
  if (!url) return null;
  let u = url.trim();
  if (u.includes("://")) {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // drop scheme (https://, ssh://)
  }
  u = u.replace(/^[^@/]+@/, ""); // drop userinfo (git@host:key, user@https)
  // host, optional :port, then a / or : separator before the path.
  const m = /^([^/:\s]+)(?::\d+)?[:/](.+)$/.exec(u);
  if (!m) return null;
  const host = m[1].toLowerCase();
  // bitbucket.org is Cloud; other bitbucket-ish hosts are assumed Server,
  // and an explicit forge.hosts claim always wins (arbitrary domains).
  const claimed = hostMap[host] === "bitbucket-server";
  const looksServer = host.includes("bitbucket") && host !== "bitbucket.org";
  if (!claimed && !looksServer) return null;
  const path = m[2].replace(/\.git$/, "").replace(/\/+$/, "");
  let segs = path.split("/").filter(Boolean);
  // https://host/scm/PROJ/repo.git -> the /scm/ prefix is transport detail.
  if (segs[0] === "scm") segs = segs.slice(1);
  // Server projects are exactly {projectKey}/{repoSlug}: anything deeper is
  // not a Server remote (nested groups exist on Cloud/GitLab, not here).
  if (segs.length !== 2) return null;
  const [owner, repo] = segs;
  if (!owner || !repo || /[\s~^:?*\\]/.test(repo)) return null;
  return { owner, repo, host, apiBase: apiBaseFor(host) };
}

/** Find the first Bitbucket Server remote of a repo (see parseBitbucketServerRemote). */
function findBitbucketServerRemote(cwd, remotes, hostMap = {}) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (!r.status) {
      const parsed = parseBitbucketServerRemote((r.stdout || "").trim(), hostMap);
      if (parsed) return { name, ...parsed };
    }
  }
  return null;
}

/** Map a Bitbucket Server PR to the common PR shape (see forge.mjs). */
function normalizePr(p, apiBase) {
  const state = p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "open" : "closed";
  return {
    number: p.id,
    title: p.title ?? "",
    url: p.links?.self?.[0]?.href ?? "",
    headRef: p.fromRef?.displayId ?? "",
    isDraft: false, // Server has no draft concept; a PR is open or closed
    state, // DECLINED / SUPERSEDED count as closed-without-merge
    updatedAt: Number.isFinite(p.updatedDate) ? new Date(p.updatedDate).toISOString() : null,
    mergedAt:
      state === "merged" && Number.isFinite(p.closedDate)
        ? new Date(p.closedDate).toISOString()
        : null,
    // Server decline is optimistic-locked: pass the PR's version along so
    // closing later survives concurrent edits (a stale version -> 409).
    version: p.version,
    apiBase, // internal: required to decline later
  };
}

/**
 * Fetch every pull request for the repo. Bitbucket Server paginates with
 * `start` cursors: the response carries { values, isLastPage, nextPageStart }.
 * Returns { prs, truncated }.
 */
async function fetchApiPrs(owner, repo, apiBase, token) {
  const out = [];
  let truncated = false;
  const base =
    `${apiBase}/projects/${encodeURIComponent(owner)}/repos/${encodeURIComponent(repo)}/pull-requests` +
    `?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&limit=${REST_PER_PAGE}`;
  let start = 0;
  for (let page = 1; page <= REST_MAX_PAGES; page++) {
    const res = await fetchWithTimeout(`${base}&start=${start}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "git-cleanup",
      },
    });
    if (!res.ok) {
      throw new PRBackendError(`Bitbucket Server API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    const items = body?.values;
    if (!Array.isArray(items)) break;
    for (const p of items) out.push(p);
    if (items.length === 0 || body.isLastPage === true) break;
    if (page >= REST_MAX_PAGES) {
      truncated = true;
      break;
    }
    // nextPageStart is the cursor the server wants next; fall back to
    // advancing by the page size so stubs / proxies still terminate.
    start = Number.isFinite(body.nextPageStart) ? body.nextPageStart : start + items.length;
  }
  return { prs: out, truncated };
}

/**
 * Load every pull request for the repo, keyed by source branch name.
 * Returns { provider, source, repo, prs: Map<headRef, PR[]>, error, truncated }
 *  - provider: "bitbucket-server"
 *  - source: "api" | "none"
 */
async function loadPRs({ cwd, remotes, track, hostMap = {} }) {
  if (!track) {
    return {
      provider: "bitbucket-server",
      source: "none",
      repo: null,
      prs: new Map(),
      error: null,
    };
  }
  const bsRemote = findBitbucketServerRemote(cwd, remotes, hostMap);
  if (!bsRemote) {
    return {
      provider: "bitbucket-server",
      source: "none",
      repo: null,
      prs: new Map(),
      error: "no Bitbucket Server remote found",
    };
  }
  const { owner, repo, host, apiBase } = bsRemote;
  const repoInfo = { owner, repo, host, apiBase };

  const token = process.env.BITBUCKET_TOKEN;
  if (!token) {
    return {
      provider: "bitbucket-server",
      source: "none",
      repo: repoInfo,
      prs: new Map(),
      error: "PR lookup unavailable: no BITBUCKET_TOKEN set.",
    };
  }

  let raw;
  let truncated = false;
  try {
    ({ prs: raw, truncated } = await fetchApiPrs(owner, repo, apiBase, token));
  } catch (err) {
    return {
      provider: "bitbucket-server",
      source: "none",
      repo: repoInfo,
      prs: new Map(),
      error: `PR lookup failed: ${err.message}`,
    };
  }

  const prs = new Map();
  const now = Date.now();
  for (const p of raw) {
    const pr = normalizePr(p, apiBase);
    if (!pr.headRef) continue;
    pr.ageDays = daysFromNowIso(pr.updatedAt, new Date(now));
    const list = prs.get(pr.headRef) ?? [];
    list.push(pr);
    prs.set(pr.headRef, list);
  }
  for (const list of prs.values()) {
    list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  return { provider: "bitbucket-server", source: "api", repo: repoInfo, prs, error: null, truncated };
}

/** Close one pull request via the API (decline), optionally with a comment. */
async function closePR({ owner, repo, pr, comment }) {
  const token = process.env.BITBUCKET_TOKEN;
  if (!token) {
    throw new PRBackendError("no BITBUCKET_TOKEN set to close pull requests");
  }
  const base = pr?.apiBase ?? apiBaseFor("bitbucket.org");
  const prBase = `${base}/projects/${encodeURIComponent(owner)}/repos/${encodeURIComponent(repo)}/pull-requests/${pr.number}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "git-cleanup",
    "Content-Type": "application/json",
  };
  // version = optimistic lock: decline refuses (409) when the PR changed
  // since we read it, so pass the version we loaded.
  const version = Number.isFinite(pr?.version) ? `?version=${pr.version}` : "";
  const decline = await fetchWithTimeout(`${prBase}/decline${version}`, {
    method: "POST",
    headers,
  });
  if (!decline.ok) {
    throw new PRBackendError(
      `Bitbucket Server API ${decline.status}: ${(await decline.text()).slice(0, 300)}`
    );
  }
  if (comment) {
    const post = await fetchWithTimeout(`${prBase}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: comment }),
    });
    if (!post.ok) {
      throw new PRBackendError(`comment failed: Bitbucket Server API ${post.status}`);
    }
  }
  return null;
}

// ---- issues capability -------------------------------------------------------
// Deliberately ABSENT: Bitbucket Server has no native issue tracker (issues
// live in Jira). resolveForgeContext throws "forge \"bitbucket-server\" has
// no issues support" for report-issue, loudly and before any network call.

/** Bitbucket Server implementation of the forge provider contract. */
export const bitbucketServerProvider = {
  id: "bitbucket-server",
  parseRemote: parseBitbucketServerRemote, // hostMap optional; claims flow via findRemote
  findRemote: findBitbucketServerRemote,
  loadPRs,
  closePR,
  // no `issues`: report-issue must fail loudly on this forge
};
