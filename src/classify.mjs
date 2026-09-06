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
    sweep: {
      // `git-cleanup sweep`: one pass over every configured repo.
      // mode "report" never deletes — the default, so a sweep with no
      // config is safe by construction. "prune" deletes through the same
      // confirmed() gate as `git-cleanup prune` (--yes required in
      // non-interactive sessions, safety bundles before any -D or push).
      // Per-repo override: a `repos` entry may be an object with a mode.
      mode: "report",
      // prune --remote inside sweep (remote deletions are pushes)
      remote: false,
      // Write a combined markdown report to this file. Relative to the
      // config file's directory (like `repos` entries). null = don't.
      reportFile: null,
      // Post the report as a forge issue on the first repo that has a
      // recognized forge remote: true = default title, or { "title": "…" }.
      // null = don't post.
      reportIssue: null,
    },
    forge: {
      // Claim hostnames for self-hosted forges that the built-in hostname
      // heuristics cannot recognize: { "git.example.com": "gitlab",
      // "git.internal": "gitea" }. An explicit mapping always wins over
      // the built-in heuristics. Used by PR tracking and report-issue alike.
      hosts: {},
    },
    repos: [],
  };
}
