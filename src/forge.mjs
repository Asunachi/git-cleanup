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
//     loadPRs({cwd, remotes, track}) -> {
//       provider: id,
//       source: "cli" | "api" | "none",      // backend that produced the data
//       repo: {owner, repo} | null,
//       prs: Map<headRef, PR[]>,             // newest activity first per ref
//       error: string | null,
//     },
//     closePR({owner, repo, source, pr, comment}),
//   }
//
// Every PR (whatever the forge) shares one shape:
//   { number, title, url, headRef, isDraft,
//     state: "open" | "closed" | "merged",
//     updatedAt: ISO | null, mergedAt: ISO | null, ageDays }
// All consumers (analyze, classify, report, cli, the GitHub Action) read
// only this shape, so adding a forge is: implement the contract in a new
// provider module and register it below.
//
// Remote detection is by hostname heuristic: github.com / gitlab.com /
// *.gitlab.* self-hosted instances. A forge host with no registered provider
// yields source "none" with a helpful error rather than a hard failure.

import { spawnSync } from "node:child_process";
import { githubProvider } from "./providers/github.mjs";

/** Registered providers, keyed by their id. Add GitLab/Bitbucket here. */
export const providers = {
  github: githubProvider,
  // gitlab: gitlabProvider,   // see README "Forge support" roadmap
};

export class ForgeError extends Error {}

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

/** Guess which forge a remote URL points at, by host. Returns an id or null. */
export function detectForge(url) {
  const host = remoteHost(url);
  if (!host) return null;
  if (host === "github.com") return "github";
  if (host.includes("gitlab")) return "gitlab"; // gitlab.com + self-hosted
  return null;
}

/**
 * Find the first remote whose URL a registered provider recognizes.
 * Returns { provider, remoteName, url } or { provider: null }.
 */
export function providerFor(cwd, remotes) {
  for (const name of remotes) {
    const r = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (r.status !== 0) continue;
    const url = (r.stdout ?? "").trim();
    const id = detectForge(url);
    const provider = id ? providers[id] ?? null : null;
    if (provider) return { provider, remoteName: name, url };
  }
  return { provider: null };
}

/** Load PRs through whichever forge owns the repo's remote. */
export async function loadPRs({ cwd, remotes, track }) {
  if (!track) {
    return { provider: null, source: "none", repo: null, prs: new Map(), error: null };
  }
  const found = providerFor(cwd, remotes);
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
  return found.provider.loadPRs({ cwd, remotes, track });
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
