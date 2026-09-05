// The `report-issue` command: keep ONE issue with a fixed title current on
// whatever forge owns the repository's remote. This is the in-CLI home of
// the posting logic that used to live in support/github/report-issue.mjs
// and support/gitlab/report-issue.mjs — one command, any forge, using the
// SAME tokens as PR enrichment:
//
//   - github:    GITHUB_TOKEN (Bearer)          base: GITHUB_API_BASE | https://api.github.com
//   - gitlab:    GITLAB_TOKEN (PRIVATE-TOKEN),  base: GITLAB_API_BASE | CI_API_V4_URL | https://<host>/api/v4
//                CI_JOB_TOKEN (JOB-TOKEN) fallback
//   - bitbucket: BITBUCKET_TOKEN (Bearer)       base: BITBUCKET_API_BASE | https://api.bitbucket.org/2.0
//   - gitea:     GITEA_TOKEN (token)            base: GITEA_API_BASE | https://<host>/api/v1
//
// ALL forge-specific knowledge — token, endpoints, pagination dialect,
// field names, create/update bodies, preview URLs — lives in each
// provider's `issues` capability (see src/forge.mjs for the contract).
// This module is a thin generic loop over that contract, so adding a forge
// means implementing the contract in a new provider module and registering
// it — nothing here changes. Forge detection is the same hostname heuristic
// the PR providers use; a remote that no registered forge claims is a hard
// error — posting without knowing where is never silently skipped.

import { detectForge, providers, ForgeError } from "./forge.mjs";

export const DEFAULT_TITLE = "git-cleanup: branch report";

/**
 * Resolve a remote URL into everything posting needs, through the `issues`
 * capability of whichever provider owns the remote's forge. `hostMap` is
 * the `forge.hosts` config (hostname -> forge id) for self-hosted
 * instances on custom domains. Throws a ForgeError when the forge is
 * unknown or the token is missing — dry-run included, because the search
 * is authenticated.
 */
export function resolveForgeContext(remoteUrl, env = process.env, hostMap = {}) {
  const forge = detectForge(remoteUrl, hostMap);
  if (!forge) {
    const recognized = Object.values(providers)
      .map((p) => p.id)
      .join(", ");
    throw new ForgeError(
      `no supported forge remote found (providers: ${recognized}) — remote: ${remoteUrl}`
    );
  }
  const impl = providers[forge]?.issues;
  if (!impl) {
    throw new ForgeError(`forge "${forge}" has no issues support`);
  }
  return impl.context(remoteUrl, env, hostMap);
}

/**
 * Post the report: update the existing issue with `title`, or create it.
 * Returns { action: "created" | "updated", number, url, dryRun? }. With
 * dryRun the read-only search runs first — so create-vs-update is resolved
 * and the target URL is real — but no write happens.
 */
export async function postReport({ markdown, title = DEFAULT_TITLE, dryRun = false, remoteUrl, env = process.env, hostMap = {} }) {
  const ctx = resolveForgeContext(remoteUrl, env, hostMap);
  const issues = providers[ctx.forge].issues;
  const existing = await issues.findIssue(ctx, title);
  if (dryRun) {
    if (existing) {
      return { action: "updated", number: existing.number, url: existing.url, dryRun: true };
    }
    return { action: "created", number: null, url: issues.previewUrl(ctx, title), dryRun: true };
  }
  if (existing) {
    const updated = await issues.updateIssue(ctx, existing.number, markdown);
    return { action: "updated", number: updated.number, url: updated.url };
  }
  const created = await issues.createIssue(ctx, title, markdown);
  return { action: "created", number: created.number, url: created.url };
}
