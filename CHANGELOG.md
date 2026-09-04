# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Backup retention: `backup.retainDays` (default 0 = keep forever) makes
  `prune` sweep this repo's own `backup-*.bundle` files older than that many
  days on every run, including no-op runs with nothing else to delete.
  Unrelated files in a custom `backup.dir` are never touched.

## [0.2.2] - 2026-09-04

### Added

- Backup safety net: before removing branches whose unique commits would be
  lost — squash/rebase-merged (`-D`), force-rule (`-D`), and remote
  (`push --delete`) deletions — their refs are written to a timestamped git
  bundle under `<git dir>/git-cleanup-backups/`, so force deletions are
  recoverable. Ancestor-merged branches deleted with plain `-d` stay
  reachable from the base and are not bundled. A failed backup aborts the
  deletion. Config: `backup.enabled` (default true) and `backup.dir`
  (default: the git dir). `scan`/`prune` output shows the bundle path plus a
  one-line restore command.
- GitHub Action (`Asunachi/git-cleanup/.github/actions/scan-report`): runs
  `scan` on a schedule and keeps a single report issue up to date. Shallow
  CI checkouts are detected and unshallowed (with an explicit refspec that
  covers every remote branch) before scanning, so merge detection sees full
  history; `unshallow: false` opts out when the checkout already uses
  `fetch-depth: 0`. Pin the action to this tag:
  `Asunachi/git-cleanup/.github/actions/scan-report@v0.2.2`.
- `rule` is now included in `scan --json` output so rule-based reasons are
  self-describing for downstream consumers.

### Fixed

- Remote symbolic HEAD refs (`refs/remotes/<remote>/HEAD`) are no longer
  listed as a phantom branch named after the remote. `%(refname:short)`
  renders those refs as just `origin`, so the old `/HEAD` suffix filter
  never matched and every normally-cloned repo showed a phantom `origin`
  branch (old enough, it was even flagged prunable). Filtering now happens
  on the full ref name; integration fixtures clone and set `origin/HEAD`
  like real repos to keep this covered.
- The scan-report action now wires the caller's `GITHUB_TOKEN` through to
  `gh` (the runner does not export it automatically), so the report issue
  is actually created/updated.

## [0.2.1] - 2026-09-04

Re-publish to clear an npm registry issue where the aggregate packument for
this brand-new scoped package returned 404 (version, dist-tag, and tarball
endpoints were unaffected). No code changes.

## [0.2.0] - 2026-09-04

First npm release (package `@maliqkara/gitcleanup`; the unscoped npm
`git-cleanup` name is held by an unrelated tool and npm blocks lookalikes).
The CLI binary stays `git-cleanup`.

### Added

- Squash/rebase-aware merge detection: branches whose tip tree already exists
  in a base branch's history are recognized as merged (their commits were
  rewritten), reported with a dedicated reason, and cleaned up locally with
  `-D` and remotely via `--remote` behind their own confirmation prompt.
  Net-empty branches — no-op commits or fully reverted work whose tree merely
  matches an old base state — are excluded via a merge-base guard, so only
  content that genuinely differs from a branch's starting point is flagged.
- `repos` entries in config now resolve relative to the config layer that
  defines them, matching the documented behavior when multiple layers are in
  play.

### Fixed

- `npm test` now uses test-runner auto-discovery, which works identically on
  Node 18/20/22 (`node --test test/` is rejected by Node 22).

## [0.1.0] - 2026-09-04

Initial release: a zero-dependency CLI that keeps Git workspaces pristine by
pruning merged, orphaned, and stale branches — cross-referenced with
pull-request status on GitHub.

### Added

- `scan` (default command): reports every branch that can be cleaned up
  (`PRUNE`), every stale branch worth reviewing (`stale`), and what is kept and
  why. Human-readable table and `--json` output; `--check` exits with code 2
  when cleanup is needed (CI-friendly).
- `prune`: deletes merged branches with `git branch -d` (or `-D` for explicit
  force rules), always after confirmation. In non-interactive sessions
  `--yes` is required. Remote cleanup (`git push --delete`) is opt-in via
  `--remote`.
- `prs`: lists open pull requests with no activity for `pr.staleAfterDays`;
  `prs --close` closes stale PRs with a comment, guarded by both config
  (`closeStaleAfterDays`) and the `--close` flag.
- Merge detection based on branch ancestry against base branches
  (`origin/<default>` from each remote, resolved offline from `origin/HEAD`,
  the local branch's upstream, or well-known names).
- Safety model: protected branches by default (`main`, `master`, `develop`,
  `release/**`, `staging`, `qa`, checked-out and base branches), unmerged work
  never deleted unless matched by an explicit `mode: "any"` rule.
- Layered configuration: built-in defaults, `~/.config/git-cleanup/config.json`,
  a repo-level `.gitcleanup.json` (searched upward from the current
  directory), and an explicit `--config` file. Includes glob rules with
  per-rule age thresholds, custom protected lists, and multi-repo scanning via
  `repos`.
- GitHub PR enrichment through the `gh` CLI or a `GITHUB_TOKEN`, falling back
  to pure git detection when neither is available.
- JSON output for automation; documented exit codes (0 ok, 1 error, 2 with
  `--check` when cleanup is needed).
- Tests: unit tests for the decision engine/globs/config merging and
  integration tests that run against real throwaway git repositories,
  including remote cleanup.
