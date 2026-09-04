// Gather everything about one repository's branches and classify each one.

import { existsSync } from "node:fs";
import {
  defaultBaseRefs,
  listBranches,
  mergedShaSet,
  remoteNameOf,
  repoMeta,
  resolveRef,
  upstreamOf,
} from "./git.mjs";
import { classify, classifyRemote, VERDICTS } from "./classify.mjs";
import { bestPR, loadPRs } from "./github.mjs";
import { daysBetween } from "./util.mjs";

function shortNameOf(remoteBranch) {
  return remoteBranch.name.split("/").slice(1).join("/");
}

/**
 * Analyze one repo. Returns:
 * {
 *   path, notGit, error,
 *   meta: { root, headBranch, remotes, remoteDefault },
 *   baseRefs, pr: { source, repo, error },
 *   branches: [ enriched branch + verdict/reason ],
 * }
 */
export async function analyzeRepo(repoPath, cfg) {
  if (!existsSync(repoPath)) {
    return {
      path: repoPath,
      notGit: true,
      error: `"${repoPath}" does not exist`,
    };
  }
  const meta = repoMeta(repoPath);
  if (!meta) {
    return {
      path: repoPath,
      notGit: true,
      error: `"${repoPath}" is not inside a git repository`,
    };
  }
  const root = meta.root;

  const baseRefs = defaultBaseRefs(meta).filter((b) => resolveRef(root, b));
  const baseShort = new Set(baseRefs.map((b) => b.split("/").pop()));
  const mergedSet =
    baseRefs.length > 0 ? mergedShaSet(root, baseRefs) : new Set();

  const localBranches = listBranches(root, "heads");
  const remoteBranches = listBranches(root, "remotes");
  const remoteShort = new Set(
    remoteBranches.map((b) => shortNameOf(b))
  );
  const hasRemotes = meta.remotes.length > 0;

  const pr = await loadPRs({
    cwd: root,
    remotes: meta.remotes,
    track: cfg.pr.track,
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const branches = [];

  for (const b of localBranches) {
    const upstream = upstreamOf(root, b.name);
    const branch = {
      name: b.name,
      shortName: b.name,
      type: "local",
      ref: b.ref,
      sha: b.sha,
      commitUnix: b.commitUnix,
      ageDays: daysBetween(nowSec, b.commitUnix),
      isHead: b.isHead,
      merged: mergedSet.has(b.sha),
      orphan: Boolean(
        hasRemotes && !upstream && !remoteShort.has(b.name)
      ),
      upstream,
      pr: pr.source !== "none" ? bestPR(pr.prs, b.name) ?? null : null,
    };
    const d = classify(branch, cfg, {
      isHead: branch.isHead,
      baseNames: new Set(baseRefs),
      baseShort,
    });
    branch.verdict = d.verdict;
    branch.reason = d.reason;
    branch.rule = d.rule;
    branches.push(branch);
  }

  for (const b of remoteBranches) {
    const short = shortNameOf(b);
    const branch = {
      name: b.name,
      shortName: short,
      type: "remote",
      remoteName: remoteNameOf(b.name),
      ref: b.ref,
      sha: b.sha,
      commitUnix: b.commitUnix,
      ageDays: daysBetween(nowSec, b.commitUnix),
      isHead: false,
      merged: mergedSet.has(b.sha),
      orphan: false,
      upstream: null,
      pr: pr.source !== "none" ? bestPR(pr.prs, short) ?? null : null,
    };
    // Protection/keep decisions from the generic classifier always win.
    const c = classify(branch, cfg, {
      isHead: false,
      baseNames: new Set(baseRefs),
      baseShort,
    });
    if (c.verdict === VERDICTS.KEEP) {
      branch.verdict = VERDICTS.KEEP;
      branch.reason = c.reason;
    } else {
      const gate = classifyRemote(branch, cfg);
      if (gate && gate.verdict === VERDICTS.DELETE) {
        branch.verdict = VERDICTS.DELETE;
        branch.reason = gate.reason;
      } else if (c.verdict === VERDICTS.DELETE) {
        // Git says merged and old, but remote cleanup is switched off:
        // surface it as informational only.
        branch.verdict = VERDICTS.WARN;
        branch.reason = "remote-disabled";
      } else {
        branch.verdict = c.verdict;
        branch.reason = c.reason;
      }
    }
    branches.push(branch);
  }

  return {
    path: repoPath,
    root,
    notGit: false,
    meta,
    baseRefs,
    pr,
    branches,
  };
}
