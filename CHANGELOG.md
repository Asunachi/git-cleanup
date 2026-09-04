# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Squash/rebase-aware merge detection: branches whose tip tree already exists
  in a base branch's history are recognized as merged (their commits were
  rewritten), reported with a dedicated reason, and cleaned up locally with
  `-D` and remotely via `--remote` behind their own confirmation prompt.
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
