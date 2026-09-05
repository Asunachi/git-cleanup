// Decision engine: given a branch (local or remote) and the merged config,
// decide whether it should be deleted, warned about, or left alone.
//
// The engine itself (classify / classifyRemote / VERDICTS plus the glob
// helpers) lives in ./engine.mjs — the single source of truth shared with
// the playground page via scripts/sync-playground.mjs. This module keeps the
// config defaults and re-exports the engine so existing import sites keep
// working.

export {
  classify,
  classifyBranch,
  classifyRemote,
  globToRegExp,
  matchesAny,
  VERDICTS,
} from "./engine.mjs";

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
      // >0: prune removes our backup bundles older than this many days
      // (0 = keep backups forever)
      retainDays: 0,
    },
    repos: [],
  };
}