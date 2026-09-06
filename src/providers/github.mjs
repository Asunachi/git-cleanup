// GitHub forge provider (see src/forge.mjs for the provider contract).
// Reads PRs via, in order:
//   1. the `gh` CLI (fast, uses its own auth)
//   2. the GitHub REST API with a GITHUB_TOKEN env var
// When neither is available PRs are simply not tracked and cleanup falls back
// to pure git merge detection.

import { spawnSync } from "node:child_process";
import { apiFetch, daysFromNowIso, fetchWithTimeout, ForgeError } from "../util.mjs";

export class PRBackendError extends Error {}

/** Parse owner/repo out of a GitHub remote URL, or null. */
export function parseGitHubRemote(url) {
  if (!url) return null;
  const cleaned = url
    .replace(/^git@/, "ssh://git@")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  // Optional :port covers SSH-over-443 remotes (ssh://git@ssh.github.com:443/...).
  const m = /github\.com(?::\d+)?[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(cleaned);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

/** Find the first GitHub remote of a repo. Returns {name, owner, repo} or null. */
function findGitHubRemote(cwd, remotes) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (!r.status) {
      const parsed = parseGitHubRemote((r.stdout || "").trim());
      if (parsed) return { name, ...parsed };
    }
  }
  return null;
}

function normalizeGhPr(p) {
  return {
    number: p.number,
    title: p.title ?? "",
    url: p.url ?? `https://github.com/${p.repository?.nameWithOwner ?? ""}/pull/${p.number}`,
    headRef: p.headRefName,
    isDraft: Boolean(p.isDraft),
    state: p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : "open",
    updatedAt: p.updatedAt,
    mergedAt: p.mergedAt ?? null,
  };
}

function normalizeRestPr(p) {
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

const REST_PER_PAGE = 100;
// Never page forever on a giant repository: beyond this many pages the PR
// list is truncated and the run reports `truncated: true` instead of
// silently judging branches against an incomplete PR picture.
const REST_MAX_PAGES = 20; // 2,000 PRs
// gh pr list caps at this many items; we ask for one more to DETECT that
// the cap was hit (a full page means more PRs exist).
const GH_LIMIT = 500;

/** rel="next" URL from a Link header, or null. */
function linkNext(header) {
  const m = /<([^>]+)>;\s*rel="?next"?/i.exec(header ?? "");
  return m ? m[1] : null;
}

async function fetchRestPrs(owner, repo, token) {
  const out = [];
  let truncated = false;
  let page = 1;
  for (;;) {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/pulls` +
        `?state=all&sort=updated&direction=desc&per_page=${REST_PER_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "git-cleanup",
        },
      }
    );
    if (!res.ok) {
      throw new PRBackendError(`GitHub API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const p of items) out.push(normalizeRestPr(p));
    // Follow pagination while the API says more pages exist; stop early (and
    // say so) once the safety cap is reached.
    if (!linkNext(res.headers?.get?.("link"))) break;
    if (page >= REST_MAX_PAGES) {
      truncated = true;
      break;
    }
    page += 1;
  }
  return { prs: out, truncated };
}

function fetchGhPrs(owner, repo) {
  const r = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--state",
      "all",
      "--limit",
      String(GH_LIMIT + 1),
      "--json",
      "number,state,title,isDraft,url,headRefName,updatedAt,mergedAt",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  // A missing gh binary shows up as r.error with status undefined — that must
  // fall through to the REST fallback, not silently read as success.
  if (!r.error && r.status === 0) {
    const json = JSON.parse(r.stdout || "[]");
    // Asking for GH_LIMIT + 1 items: receiving all of them proves the repo
    // has more than GH_LIMIT PRs, so the list is truncated.
    return { prs: json.map(normalizeGhPr), truncated: json.length > GH_LIMIT };
  }
  if (r.error) {
    throw new PRBackendError(`gh unavailable: ${r.error.message}`);
  }
  throw new PRBackendError((r.stderr || "gh failed").trim().split("\n").pop());
}

/**
 * Load every PR for the repo, keyed by head branch name.
 * Returns { provider, source, repo, prs: Map<headRef, PR[]>, error }
 *  - provider: "github"
 *  - source: "gh" | "rest" | "none"
 *  - prs contains all PRs (open/merged/closed), newest-activity first.
 */
async function loadPRs({ cwd, remotes, track }) {
  if (!track) {
    return { provider: "github", source: "none", repo: null, prs: new Map(), error: null };
  }
  const ghRemote = findGitHubRemote(cwd, remotes);
  if (!ghRemote) {
    return {
      provider: "github",
      source: "none",
      repo: null,
      prs: new Map(),
      error: "no GitHub remote found",
    };
  }
  const { owner, repo } = ghRemote;

  let raw = null;
  let source = null;
  let truncated = false;
  try {
    ({ prs: raw, truncated } = fetchGhPrs(owner, repo));
    source = "gh";
  } catch (ghErr) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        provider: "github",
        source: "none",
        repo: { owner, repo },
        prs: new Map(),
        error: `PR lookup unavailable: ${ghErr.message}. Install/authenticate gh or set GITHUB_TOKEN.`,
      };
    }
    try {
      ({ prs: raw, truncated } = await fetchRestPrs(owner, repo, token));
      source = "rest";
    } catch (restErr) {
      return {
        provider: "github",
        source: "none",
        repo: { owner, repo },
        prs: new Map(),
        error: `PR lookup failed (gh: ${ghErr.message}; api: ${restErr.message})`,
      };
    }
  }

  const prs = new Map();
  const now = Date.now();
  for (const p of raw) {
    if (!p.headRef) continue;
    p.ageDays = daysFromNowIso(p.updatedAt, new Date(now));
    const list = prs.get(p.headRef) ?? [];
    list.push(p);
    prs.set(p.headRef, list);
  }
  for (const list of prs.values()) {
    list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  return { provider: "github", source, repo: { owner, repo }, prs, error: null, truncated };
}

/** Close one PR via the backend that was used to read it. */
export async function closePR({ owner, repo, source, pr, comment }) {
  const target = `${owner}/${repo}`;
  if (source === "gh") {
    const args = ["pr", "close", String(pr.number), "--repo", target];
    if (comment) args.push("--comment", comment);
    const r = spawnSync("gh", args, { encoding: "utf8" });
    // A missing gh binary shows up as r.error with status undefined. Treating
    // that as success would report "closed" for a PR that is still open —
    // surface it as an error instead (regression: it used to return null).
    if (r.error) {
      throw new PRBackendError(`gh unavailable: ${r.error.message}`);
    }
    if (r.status !== 0) {
      throw new PRBackendError((r.stderr || "gh failed").trim().split("\n").pop());
    }
    return null;
  }
  if (source === "rest") {
    const token = process.env.GITHUB_TOKEN;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "git-cleanup",
      "Content-Type": "application/json",
    };
    const patch = await fetchWithTimeout(`https://api.github.com/repos/${target}/pulls/${pr.number}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed" }),
    });
    if (!patch.ok) {
      throw new PRBackendError(`GitHub API ${patch.status}: ${(await patch.text()).slice(0, 300)}`);
    }
    if (comment) {
      const post = await fetchWithTimeout(`https://api.github.com/repos/${target}/issues/${pr.number}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: comment }),
      });
      if (!post.ok) {
        throw new PRBackendError(`comment failed: GitHub API ${post.status}`);
      }
    }
    return null;
  }
  throw new PRBackendError("no PR backend available to close PRs");
}

// ---- issues capability (report-issue) --------------------------------------
// Keeps ONE issue with a fixed title current on this forge: find by exact
// title (PRs on the issues endpoint are ignored), then create or update its
// body. The dedup search is sorted most-recently-updated so a weekly-updated
// report issue survives the pagination cap even on repos with thousands of
// newer open issues.

const ISSUE_PER_PAGE = 100;
const ISSUE_MAX_PAGES = 5; // 500 issues max searched per run
const LABEL = "GitHub";

export const issues = {
  /** Token + endpoints for report-issue on this forge (throws ForgeError). */
  context(remoteUrl, env = process.env) {
    const p = parseGitHubRemote(remoteUrl);
    if (!p) throw new ForgeError(`cannot parse GitHub remote: ${remoteUrl}`);
    if (!env.GITHUB_TOKEN) throw new ForgeError("no token available: set GITHUB_TOKEN");
    return {
      forge: "github",
      apiBase: env.GITHUB_API_BASE || "https://api.github.com",
      webBase: "https://github.com",
      owner: p.owner,
      repo: p.repo,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },
    };
  },

  /** The open issue with exactly `title`, or null. */
  async findIssue(ctx, title) {
    for (let page = 1; page <= ISSUE_MAX_PAGES; page++) {
      const res = await apiFetch(
        `${ctx.apiBase}/repos/${ctx.owner}/${ctx.repo}/issues?state=open&sort=updated&direction=desc&per_page=${ISSUE_PER_PAGE}&page=${page}`,
        { headers: ctx.headers },
        LABEL
      );
      const items = await res.json();
      if (!Array.isArray(items)) break;
      for (const it of items) {
        if (it.pull_request) continue; // the issues endpoint returns PRs too
        if (it.title === title) return { title: it.title, number: it.number, url: it.html_url };
      }
      if (!linkNext(res.headers?.get?.("link"))) break;
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

/** GitHub implementation of the forge provider contract. */
export const githubProvider = {
  id: "github",
  parseRemote: parseGitHubRemote,
  findRemote: findGitHubRemote,
  loadPRs,
  closePR,
  issues,
};

