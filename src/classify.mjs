// Decision engine: given a branch (local or remote) and the merged config,
// decide whether it should be deleted, warned about, or left alone.

import { matchesAny } from "./util.mjs";

export const VERDICTS = {
  DELETE: "delete", // safe to prune
  WARN: "warn", // stale but needs a human decision
  KEEP: "keep", // active / protected / too young
};

const DEFAULT_PROTECTED = [
  "main",
  "master",
  "develop",
  "dev",
  "release",
  "release/**",
  "staging",
  "qa",
  "trunk",
  "HEAD",
];

export function defaults() {
  return {
    protected: [],
    // Merged branches at least this old (days, tip commit age) are prunable.
    deleteMergedAfterDays: 21,
    // Extra rules: [{ match, mode: "merged"|"any", minAgeDays? }].
    //   merged - like the generic threshold but with a custom age / glob
    //   any    - delete even when unmerged (force; local branches only)
    // Rules apply to local branches. First matching rule wins.
    rules: [],
    // Unmerged branches older than this are flagged as stale (never deleted).
    warnUnmergedAfterDays: 45,
    pr: {
      track: true, // enrich branches with PR status when a backend exists
      staleAfterDays: 30, // open PR with no activity => stale
      closeStaleAfterDays: 0, // >0 enables `git-cleanup prs --close`
      closeComment:
        "This pull request has been automatically flagged as stale and closed by git-cleanup. Reopen it if the work is still in progress.",
    },
    remote: {
      // prune --remote deletes merged remote branches past the merged threshold
      pruneMerged: true,
      // >0: delete remote branches whose PR was closed without merging and
      // whose last PR activity is older than this many days
      deleteAbandonedAfterDays: 0,
    },
    backup: {
      // Before force (-D) or remote deletions, write the deleted refs into a
      // timestamped git bundle so the work stays recoverable. Merged local
      // branches deleted with plain -d need no backup: their commits remain
      // reachable from the base branch.
      enabled: true,
      // Directory for bundles; null = <git dir>/git-cleanup-backups
      dir: null,
    },
    repos: [],
  };
}

/** Days a rule requires before it fires (defaults per mode). */
function ruleAge(rule, cfg) {
  if (Number.isFinite(rule.minAgeDays)) return rule.minAgeDays;
  return rule.mode === "any" ? 0 : cfg.deleteMergedAfterDays;
}

/**
 * classify a single branch.
 * branch: { name, type: "local"|"remote", shortName, ageDays, merged, orphan, pr }
 * ctx:    { isHead, baseNames:Set<string>, baseShort:Set<string> }
 *
 * Rules only ever apply to local branches; remote pruning has its own,
 * narrower gate (see classifyRemote).
 */
export function classify(branch, cfg, ctx) {
  const name = branch.shortName ?? branch.name;

  // 1. Never touch protected refs, the checked-out branch, or base branches.
  const protectedAll = [...DEFAULT_PROTECTED, ...(cfg.protected ?? [])];
  if (
    ctx.isHead ||
    ctx.baseNames.has(branch.name) ||
    ctx.baseShort.has(name) ||
    matchesAny(protectedAll, name)
  ) {
    return {
      verdict: VERDICTS.KEEP,
      reason: ctx.isHead ? "head" : "protected",
    };
  }

  const rule =
    branch.type === "local"
      ? (cfg.rules ?? []).find((r) => matchesAny([r.match], name))
      : undefined;

  // 2. Explicit force rule: delete regardless of merge state.
  if (rule && rule.mode === "any" && branch.ageDays >= ruleAge(rule, cfg)) {
    return { verdict: VERDICTS.DELETE, reason: "rule-force", rule: rule.match };
  }

  // 3. Integrated work: the safe, default cleanup path. Two flavors:
  //   merged        - tip is an ancestor of a base branch (regular merge)
  //   contentMerged - tip tree already exists in base history (squash/rebase)
  // A matching merged-mode rule fully owns the threshold for that branch (it
  // can raise OR lower the generic deleteMergedAfterDays), so do not fall
  // through to the generic one.
  const integrated = branch.merged || branch.contentMerged;
  if (integrated) {
    const ancestor = Boolean(branch.merged);
    if (rule && rule.mode === "merged") {
      if (branch.ageDays >= ruleAge(rule, cfg)) {
        return {
          verdict: VERDICTS.DELETE,
          reason: ancestor ? "merged-rule" : "squash-rule",
          rule: rule.match,
        };
      }
      return { verdict: VERDICTS.KEEP, reason: "rule-young" };
    }
    if (branch.ageDays >= cfg.deleteMergedAfterDays) {
      return {
        verdict: VERDICTS.DELETE,
        reason: ancestor ? "merged" : "squash-merged",
      };
    }
    return {
      verdict: VERDICTS.KEEP,
      reason: ancestor ? "too-young" : "content-young",
    };
  }

  // 4. Unmerged branches.
  if (branch.pr && branch.pr.state === "open") {
    // An open PR means the work is (probably) alive.
    if (branch.pr.ageDays < cfg.warnUnmergedAfterDays) {
      return { verdict: VERDICTS.KEEP, reason: "open-pr" };
    }
    return { verdict: VERDICTS.WARN, reason: "stale-pr" };
  }
  if (rule && rule.mode === "merged") {
    // A merged-only rule matched but the branch is not merged: keep it.
    return { verdict: VERDICTS.KEEP, reason: "unmerged-rule" };
  }
  if (branch.ageDays >= cfg.warnUnmergedAfterDays) {
    return { verdict: VERDICTS.WARN, reason: "stale-unmerged" };
  }
  return { verdict: VERDICTS.KEEP, reason: "active" };
}

/**
 * Gate for remote pruning (applies only when the user opted into touching
 * remote branches). Returns { verdict, reason } or null when the branch is
 * not eligible for remote cleanup under the current config.
 */
export function classifyRemote(branch, cfg) {
  if (branch.merged || branch.contentMerged) {
    if (!cfg.remote.pruneMerged) return null;
    if (branch.ageDays >= cfg.deleteMergedAfterDays) {
      return {
        verdict: VERDICTS.DELETE,
        reason: branch.merged ? "merged" : "squash-merged",
      };
    }
    return null;
  }
  // Abandoned PR: closed without merging, no activity for a while.
  if (
    cfg.remote.deleteAbandonedAfterDays > 0 &&
    branch.pr &&
    branch.pr.state === "closed" &&
    branch.pr.ageDays >= cfg.remote.deleteAbandonedAfterDays
  ) {
    return { verdict: VERDICTS.DELETE, reason: "abandoned-pr" };
  }
  return null;
}
