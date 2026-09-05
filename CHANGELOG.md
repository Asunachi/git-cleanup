# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI now hard-fails on any commit whose playground bundle is stale: a
  dedicated `playground-fresh` job runs `npm run sync:playground` on the
  merged tree and fails if it produces a diff, so a commit touching
  `src/engine.mjs` without re-bundling it into `index.html` can never land.
  (The parity tests already caught behavioral drift; this catches the
  un-committed sync itself.)
- The parity suite is now property-tested: a seeded fuzzer (fixed seed, so
  any failure reproduces) throws 2,000 random branch × config × base-context
  shapes at both the page's bundled engine and the real one and requires
  byte-identical verdicts from `classify`, `classifyRemote`, and
  `classifyBranch`, plus structural invariants and coverage assertions that
  stop the generator from going vacuously green. Verified to catch drift the
  hand-picked cases miss: flipping a single `>=` to `>` in the bundled copy
  fails the fuzz while every hand-picked parity case still passes.

## [0.2.7] - 2026-09-05

### Fixed

- `--repo --json` (or `--config --json`) no longer silently swallows the
  following flag as the value: a value that is missing or starts with `-`
  now errors with `missing value for --repo/--config` instead of treating
  `--json` as a repo path.
- When `git push --delete` fails because the branch was already deleted on
  the server (web UI, another machine, an earlier run), `prune --remote` now
  prunes the stale local tracking ref instead of reporting a dead-end error.
  Whether the ref still exists is verified with `ls-remote` (not by parsing
  git's localized error text), and only when `ls-remote` itself works — so
  auth/network failures and refs that still exist (e.g. protected branches)
  keep surfacing as real errors. The summary reports these as
  `pruned N stale remote refs`.
- The playground no longer disagrees with the CLI about protected remote
  branches: its gate-first layering would have PRUNED a protected remote
  like `origin/release/v1`, which `analyze.mjs` correctly keeps. The demo
  and the analyzer now share one implementation (see below), and the
  simulated repo includes that branch as a regression fixture.
- The test suite's reported size is now the true count on every Node
  version: `test/helpers.mjs` moved to `support/helpers.mjs` so Node's test
  runner no longer counts the fixture file itself as a passing test.

### Added

- The decision engine moved to a single source of truth (`src/engine.mjs`,
  dependency-free): `src/classify.mjs` and `src/util.mjs` re-export it, and
  the playground page bundles it verbatim via
  `npm run sync:playground` (scripts/sync-playground.mjs) instead of the
  hand-ported twin that had drifted twice. A parity test now compares the
  page's bundled engine against the real one across the full verdict space
  and fails CI if they diverge — and it also pins the page's "N tests"
  badge to the actual suite size so the demo can't lie about coverage
  again. A reset button returns the playground to its default thresholds.
- The per-branch verdict layering itself (classify first, remote gate
  second, protection always wins) is now shared too: `analyze.mjs` and the
  playground both call `classifyBranch()` from the engine, so the demo's
  view of a branch can never differ from the CLI's. The simulated repo
  gained remote `shortName` handling matching analyze, and the parity test
  now evals the page's fixture and compares every simulated branch against
  the real layering across six threshold/toggle scenarios, pins the demo's
  canonical verdict table, and locks the layer corners (protected remotes,
  remote-disabled, abandoned remotes, force rules never touching remotes).
- Cross-platform stress tests for the `-d` fallback: the worktree-refusal
  case now also runs with a worktree path containing spaces (the quoting
  hazard that behaves differently on Windows vs POSIX), asserting the
  refusal names the exact path with separators normalized, and the refusal
  matcher accepts both git phrasings (`used by worktree at` / `checked out
  at`) so it holds across git versions on the CI OS matrix.

## [0.2.6] - 2026-09-05

### Fixed

- When `git branch -d` refuses because a branch is merged into a remote base
  branch but not the local `HEAD` (e.g. a stale local default branch), prune
  no longer reports a dead-end error. The scan has already proven the tip is
  an ancestor of a base ref, so the branch is backed up into a safety bundle
  and force-deleted — recoverable even if that base ref later disappears. A
  failed backup still aborts the deletion, and real refusals (a branch
  checked out in another worktree) still surface as errors.

### Added

- End-to-end tests for `prs --json` and `prs --close` with a stubbed GitHub
  API (multi-repo document shape, API-failure error entries, and the close
  flow: `PATCH state: closed` + comment per stale PR, fresh PRs untouched).

## [0.2.5] - 2026-09-05

### Fixed

- `prs --json` always emits exactly one parseable JSON document. It used to
  print nothing when no PR backend reported stale PRs and one object per
  repo when several did — empty or concatenated output that no consumer
  could parse. Output is now an array in input order (per-repo stale lists,
  `error` entries where a repo or its PR backend failed), matching the
  single-document promise of `scan --json`.
- `scan --repo <file>` (a path that exists but is not a directory) used to
  crash with a bare `spawnSync git ENOTDIR`; it now reports
  `"…" is not a directory` and exits 1, with the error inside the JSON doc
  in `--json` mode.
- The playground's timeline bars were mirrored: a branch last touched `age`
  days ago was drawn starting at `age/180` of the track, so old branches
  looked fresh and vice versa. Bars now start at `(180 − age)/180` (oldest
  left → now right) and the axis markers align with the gridlines.
- `scan --json` no longer drops the `provider` field when it is `null`:
  `null ?? undefined` collapsed the explicit "no forge provider consulted"
  state (PRs off or an unrecognized remote) into an absent key, so consumers
  could not distinguish it from a missing field.
- The README no-install quick-start uses `npx -y @maliqkara/gitcleanup@latest`:
  on npm ≥ 11 the bare `npx -y @maliqkara/gitcleanup` form fails to resolve a
  scoped package's bin ("command not found") — the explicit `@latest` works.

### Added

- README "Performance" section with measured synthetic-repo scan times (0.4s
  / 1.5s / 3.2s for 91 / 361 / 751 branches) and the scaling model.

## [0.2.4] - 2026-09-05

### Added

- GitLab provider: merge requests are read over the GitLab REST API with a
  `GITLAB_TOKEN` (`PRIVATE-TOKEN` header), keyed by source branch and mapped
  to the common PR shape, so open/MR state cross-references work on gitlab.com
  and self-hosted `*.gitlab.*` instances (API base derived from the remote
  host, override with `GITLAB_API_BASE`). Closing an MR uses
  `PUT /merge_requests/:iid` plus an optional note. Nested-group projects
  (`group/sub/repo`) resolve correctly. See the README "Forge support"
  section.
- CI now runs the test suite on Windows and macOS as well as Linux (Node
  18/20/22 per OS), so git plumbing is verified cross-platform on every push.
  A `release-check` workflow additionally packs the tarball, installs it into
  a temp prefix, and runs the installed CLI on all three OSes — triggered by
  `v*` tag pushes and on demand via `workflow_dispatch` before publishing
  (see CONTRIBUTING "Releasing").
- The demo page (`index.html`) is rebuilt as an interactive playground: a
  simulated repo rendered as a live branch graph that re-classifies every
  branch as you drag the age thresholds (faithful port of `src/classify.mjs`),
  a CLI-mirror of the current state, a squash-detection explainer, plus the
  glob and config demos — published to GitHub Pages. The README now embeds an
  animated SVG terminal demo (`demo.svg`, scan → prune with backup → the
  unattended CI report) and links the live playground.

### Fixed

- The backup-retention test now sets the fresh bundle's mtime explicitly:
  on Windows, `copyFileSync` (via `CopyFileW`) preserves the source file's
  timestamps, so the "fresh" copy inherited the backdated mtime and the
  retention sweep — correctly — removed it. The test failed only on the new
  Windows CI leg; the sweep's behavior is unchanged.

## [0.2.3] - 2026-09-05

### Fixed

- The scan-report action's outputs (`prunable`, `stale`, `kept`, `errors`,
  `issue-number`) are populated again: composite actions must map each
  declared output to a `value` from an inner step, which the v0.2.2 manifest
  omitted (the action ran and posted issues fine, but consumers reading
  `steps.<id>.outputs.*` got empty strings). Consumers pinning `@v0.2.2`
  should re-pin to `@v0.2.3`.
- A missing `gh` binary no longer reads as success: an uninstalled `gh`
  made the spawn return no status, which was treated as "worked" and
  reported `PRs via gh` with zero PRs, silently skipping the REST fallback.
  It now falls through to the `GITHUB_TOKEN` REST path (or honest
  degradation) as intended.

### Added

- Backup retention: `backup.retainDays` (default 0 = keep forever) makes
  `prune` sweep this repo's own `backup-*.bundle` files older than that many
  days on every run, including no-op runs with nothing else to delete.
  Unrelated files in a custom `backup.dir` are never touched.
- Forge abstraction: PR enrichment now lives behind a provider interface
  (`src/forge.mjs` + `src/providers/github.mjs`); consumers read only a
  common PR shape, and remotes are detected by hostname. `scan --json` now
  reports the active `provider`.

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
