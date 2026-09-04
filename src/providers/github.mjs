// GitHub forge provider (see src/forge.mjs for the provider contract).
// Reads PRs via, in order:
//   1. the `gh` CLI (fast, uses its own auth)
//   2. the GitHub REST API with a GITHUB_TOKEN env var
// When neither is available PRs are simply not tracked and cleanup falls back
// to pure git merge detection.

import { spawnSync } from "node:child_process";
import { daysFromNowIso } from "../util.mjs";

export class PRBackendError extends Error {}

/** Parse owner/repo out of a GitHub remote URL, or null. */
function parseGitHubRemote(url) {
  if (!url) return null;
  const cleaned = url
    .replace(/^git@/, "ssh://git@")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(cleaned);
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

async function fetchRestPrs(owner, repo, token) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls` +
        `?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
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
    if (items.length < 100) break;
  }
  return out;
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
      "500",
      "--json",
      "number,state,title,isDraft,url,headRefName,updatedAt,mergedAt",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  // A missing gh binary shows up as r.error with status undefined — that must
  // fall through to the REST fallback, not silently read as success.
  if (!r.error && r.status === 0) {
    const json = JSON.parse(r.stdout || "[]");
    return json.map(normalizeGhPr);
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
  try {
    raw = fetchGhPrs(owner, repo);
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
      raw = await fetchRestPrs(owner, repo, token);
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
  return { provider: "github", source, repo: { owner, repo }, prs, error: null };
}

/** Close one PR via the backend that was used to read it. */
async function closePR({ owner, repo, source, pr, comment }) {
  const target = `${owner}/${repo}`;
  if (source === "gh") {
    const args = ["pr", "close", String(pr.number), "--repo", target];
    if (comment) args.push("--comment", comment);
    const r = spawnSync("gh", args, { encoding: "utf8" });
    if (!r.status) return null;
    throw new PRBackendError((r.stderr || "gh failed").trim().split("\n").pop());
  }
  if (source === "rest") {
    const token = process.env.GITHUB_TOKEN;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "git-cleanup",
      "Content-Type": "application/json",
    };
    const patch = await fetch(`https://api.github.com/repos/${target}/pulls/${pr.number}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed" }),
    });
    if (!patch.ok) {
      throw new PRBackendError(`GitHub API ${patch.status}: ${(await patch.text()).slice(0, 300)}`);
    }
    if (comment) {
      const post = await fetch(`https://api.github.com/repos/${target}/issues/${pr.number}/comments`, {
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

/** GitHub implementation of the forge provider contract. */
export const githubProvider = {
  id: "github",
  parseRemote: parseGitHubRemote,
  findRemote: findGitHubRemote,
  loadPRs,
  closePR,
};

