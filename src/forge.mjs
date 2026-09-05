// Forge abstraction layer.
//
// A forge is a code-hosting service whose pull/merge requests carry the
// branch lifecycle we cross-reference (open keeps work alive, closed-unmerged
// flags it abandoned, merged explains a deletion). Each forge is implemented
// by a "provider" module in src/providers/ that satisfies this contract:
//
//   {
//     id: string,                      // e.g. "github"
//     parseRemote(url) -> {owner, repo} | null,
//     findRemote(cwd, remotes) -> {name, owner, repo} | null,
//     loadPRs({cwd, remotes, track, hostMap}) -> {   // hostMap = forge.hosts
//       provider: id,
//       source: "cli" | "api" | "none",      // backend that produced the data
//       repo: {owner, repo} | null,
//       prs: Map<headRef, PR[]>,             // newest activity first per ref
//       error: string | null,
//     },
//     closePR({owner, repo, source, pr, comment}),
//     issues: {                            // required: report-issue posts
//       context(remoteUrl, env) -> {forge, apiBase, webBase, owner, repo,
//                                   project?, headers}  // throws ForgeError
//       findIssue(ctx, title)     -> {title, number, url} | null,
//       createIssue(ctx, title, body) -> {number, url},
//       updateIssue(ctx, number, body) -> {number, url},
//       previewUrl(ctx, title) -> string,   // where a created issue would live
//     },
//   }
//
// Every PR (whatever the forge) shares one shape:
//   { number, title, url, headRef, isDraft,
//     state: "open" | "closed" | "merged",
//     updatedAt: ISO | null, mergedAt: ISO | null, ageDays }
// All consumers (analyze, classify, report, cli, the GitHub Action) read
// only this shape, and `report-issue` reads only the `issues` shape above,
// so adding a forge is: implement the contract in a new provider module and
// register it below.
//
// Remote detection is by hostname heuristic: github.com / gitlab.com /
// *.gitlab.* self-hosted instances / bitbucket.org / gitea.com +
// codeberg.org + forgejo.org (Gitea-family hosts; arbitrary self-hosted
// Gitea domains have no distinctive hostname and are not claimed). The
// `forge.hosts` config map claims extra hostnames explicitly (e.g.
// { "git.example.com": "gitlab", "git.internal": "gitea" }) and always
// wins over the heuristics; it is threaded through as `hostMap` by every
// detection and parsing entry point. A forge host with no registered
// provider yields source "none" with a helpful error rather than a hard
// failure.

import { spawnSync } from "node:child_process";
import { ForgeError } from "./util.mjs";
import { githubProvider } from "./providers/github.mjs";
import { gitlabProvider } from "./providers/gitlab.mjs";
import { bitbucketProvider } from "./providers/bitbucket.mjs";
import { giteaProvider } from "./providers/gitea.mjs";

// ForgeError lives in util.mjs (providers throw it too, without importing
// back into this module); re-exported here for importers of forge.mjs.
export { ForgeError };

/** Registered providers, keyed by their id. Add a forge here + in detectForge. */
export const providers = {
  github: githubProvider,
  gitlab: gitlabProvider,
  bitbucket: bitbucketProvider,
  gitea: giteaProvider,
};

/** Hostname of a git remote URL (https, ssh://, or scp-like git@host:path). */
export function remoteHost(url) {
  if (!url) return null;
  let u = url.trim();
  u = u.replace(/^ssh:\/\//, ""); // ssh://git@host -> git@host
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // https://, git:// -> host/...
  const at = u.indexOf("@");
  if (at !== -1) u = u.slice(at + 1); // drop userinfo (git@host:path)
  const host = u.split(/[\/:\s]/, 1)[0];
  return host ? host.toLowerCase() : null;
}

/**
 * Guess which forge a remote URL points at, by host. `hostMap` is the
 * `forge.hosts` config (hostname -> forge id); an explicit mapping always
 * wins over the built-in hostname heuristics. Returns an id or null.
 */
export function detectForge(url, hostMap = {}) {
  const host = remoteHost(url);
  if (!host) return null;
  if (Object.prototype.hasOwnProperty.call(hostMap, host)) return hostMap[host];
  if (host === "github.com") return "github";
  if (host.includes("gitlab")) return "gitlab"; // gitlab.com + self-hosted
  if (host === "bitbucket.org") return "bitbucket"; // Cloud only (Server has a different API)
  // Gitea-family hosts: gitea.com + the big Gitea/Forgejo instances. Other
  // self-hosted Gitea domains have no distinctive hostname to detect.
  if (host === "gitea.com" || host === "codeberg.org" || host === "forgejo.org") {
    return "gitea";
  }
  return null;
}

/**
 * Find the first remote whose URL a registered provider recognizes.
 * `hostMap` is the `forge.hosts` config (see detectForge).
 * Returns { provider, remoteName, url } or { provider: null }.
 */
export function providerFor(cwd, remotes, hostMap = {}) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (r.status !== 0) continue;
    const url = (r.stdout ?? "").trim();
    const id = detectForge(url, hostMap);
    const provider = id ? providers[id] ?? null : null;
    if (provider) return { provider, remoteName: name, url };
  }
  return { provider: null };
}

/**
 * Load PRs through whichever forge owns the repo's remote.
 * `hostMap` is the `forge.hosts` config (see detectForge); it is passed to
 * the provider so its own remote re-parsing accepts claimed hostnames.
 */
export async function loadPRs({ cwd, remotes, track, hostMap = {} }) {
  if (!track) {
    return { provider: null, source: "none", repo: null, prs: new Map(), error: null };
  }
  const found = providerFor(cwd, remotes, hostMap);
  if (!found.provider) {
    const recognized = Object.values(providers)
      .map((p) => p.id)
      .join(", ");
    return {
      provider: null,
      source: "none",
      repo: null,
      prs: new Map(),
      error: `no supported forge remote found (providers: ${recognized})`,
    };
  }
  return found.provider.loadPRs({ cwd, remotes, track, hostMap });
}

/** Pick the most relevant PR for a branch (newest activity first). */
export function bestPR(prsMap, shortName) {
  const list = prsMap.get(shortName);
  return list && list.length ? list[0] : null;
}

/** Open PRs that have had no activity for staleAfterDays or more. */
export function stalePRs(prs, staleAfterDays) {
  const out = [];
  for (const list of prs.values()) {
    for (const p of list) {
      if (p.state === "open" && (p.ageDays ?? 0) >= staleAfterDays) {
        out.push(p);
      }
    }
  }
  out.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  return out;
}

/** Close one PR through the provider that loaded it. */
export async function closePR({ provider, owner, repo, source, pr, comment }) {
  const impl = provider ? providers[provider] : null;
  if (!impl) {
    throw new ForgeError(`no forge provider for "${provider}"`);
  }
  return impl.closePR({ owner, repo, source, pr, comment });
}
