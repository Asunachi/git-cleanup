# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A 60-second walkthrough video (`demo.mp4`, H.264, 1280×720) embedded at
  the top of the README. It is built from real terminal output captured on
  a clone of facebook/react (969 branches, no token, git evidence only):
  `scan` (198 prunable / 727 stale / 56 kept) → `prune` (bundle-safe,
  11 squash/rebase branches backed up before deletion) → `backup list` →
  `backup restore` (all 11 branches back at their exact commits, verified
  by hash). A timed on-screen narration strip walks through each scene;
  the frame generator renders from captured transcripts, so every line on
  screen is real output.
- A dedicated Homebrew tap repository, `homebrew-git-cleanup/` in this
  tree — the content of `github.com/Asunachi/homebrew-git-cleanup` (tap
  name `Asunachi/git-cleanup`). Homebrew taps must live in a
  `homebrew-`-prefixed repository, so a formula inside this repo could
  never actually be tapped (`brew tap user/repo` maps to
  `user/homebrew-<repo>`); the formula now has its own home and this repo
  ships no copy of it, so the two can't drift. The tap's
  `update-formula` workflow (daily poll + manual dispatch, zero secrets)
  rewrites the formula's version and sha256 from each new upstream
  release, replacing the manual release chore. Install is unchanged:
  `brew tap Asunachi/git-cleanup && brew install git-cleanup`.
- A Bitbucket Server / Data Center forge provider behind the forge
  contract, for self-hosted instances: `stash.internal`, `bitbucket.corp`,
  or any host claimed via `forge.hosts` (`{ "stash.internal":
  "bitbucket-server" }`). Hostnames containing `bitbucket` other than
  `bitbucket.org` are assumed to be Server. It speaks the Server REST
  dialect — `/rest/api/1.0`, `isLastPage`/`nextPageStart` pagination,
  epoch-ms dates, `fromRef` branch keys, versioned declines for `prs
  --close`, and a loud "no issues support" failure for report-issue (its
  issues live in Jira). Server remotes authenticate with the same
  `BITBUCKET_TOKEN` as Cloud, and `doctor` reports them correctly.
- The GitHub Pages deploy (`pages.yml`) now runs on every `v*` release tag
  (in addition to `main` pushes and manual dispatch), so the playground at
  asunachi.github.io/git-cleanup always mirrors the latest published
  release. Before deploying it regenerates `index.html` from
  `src/engine.mjs` and refuses to publish a page that drifted from the
  committed bundle — the same freshness gate CI enforces per PR.

## [0.3.0] - 2026-09-06

### Security

- `prs --close` no longer reports success when the `gh` binary is missing:
  a spawn error used to be read as "closed" (`!r.status` on `undefined`),
  printing `✓ closed #N` for a PR that was still open. It now throws, like
  every other `gh` failure, and the close flow surfaces it as an error.
- The GitHub Action's report-issue search no longer caps at 100 open
  issues: the dedup lookup paginates through 500, so the single report
  issue can't be silently duplicated on repos with many open issues.

### Fixed

- PR/MR pagination is no longer silently truncated at 500 items. The
  GitHub REST provider follows the `Link` header (GitLab: `x-next-page`)
  up to a safety cap of 2,000 PRs, and the `gh` CLI path asks for one more
  item than its 500-item cap to *detect* that more exist. When the cap is
  hit, `scan --json` reports `pr.truncated: true`, the human report shows
  a warning, and `prs` lists a warning per affected repo — branches past
  the cap are never judged against a partial PR picture without the user
  knowing.

### Added

- Shell completions for bash, zsh, and fish, shipped in the npm package
  (`support/completions/`) and printed by the new `git-cleanup completions
  <bash|zsh|fish>` subcommand. `--help` now documents the subcommand,
  gives examples for every command, and lists the environment variables
  (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITLAB_API_BASE`, `GIT_CLEANUP_YES`,
  `GIT_CLEANUP_NO_COLOR`).
- A zero-dependency linter (`npm run lint`, also run inside `npm test`):
  syntax-checks every JS file with `node --check` and enforces no tabs, no
  trailing whitespace, and a final newline. A commit that breaks syntax or
  formatting can no longer go green.
- A seeded differential fuzz for merge detection: the generator builds
  random real repositories (merge / squash / revert / no-op / divergent
  histories against a bare origin) and requires the analyzer's verdicts to
  match each branch's true fate. `MERGE_FUZZ_CASES` and `MERGE_FUZZ_SEED`
  scale and reseed it (default 15 cases, fixed seed).
- Homebrew readiness: the repo is now a tap (`brew tap
  Asunachi/git-cleanup && brew install git-cleanup`) via
  `Formula/git-cleanup.rb`, pinned to the published npm tarball with its
  real sha256; the release flow in CONTRIBUTING documents updating it.
- Repository metadata for contributors and adopters: `SECURITY.md`
  (supported versions, private reporting, the tool's trust model),
  `CODE_OF_CONDUCT.md`, GitHub issue forms (bug + feature), a PR
  template, and GitHub Discussions templates (`general`, `q-a`, `ideas`,
  `show-and-tell`).
- `globToRegExp` now memoizes compiled regexes (identical behavior, less
  repeated parsing when many branches share patterns).
- Bitbucket provider: pull requests are read over the Bitbucket Cloud REST
  API (`BITBUCKET_TOKEN` app password, `Bearer` auth), keyed by source
  branch; `OPEN`/`MERGED`/`DECLINED`/`SUPERSEDED` states map onto the
  shared PR shape (declined/superseded count as closed-without-merge, the
  abandoned-PR signal), pagination follows the API's embedded `next` URL
  with the same 2,000-item truncation cap, and `prs --close` declines the
  PR with an optional comment. Remotes are detected by host
  (`bitbucket.org` only — Bitbucket Server's different API is not
  claimed). See the README "Forge support" section.
- Shell and git hook snippets (`support/dotfiles/`, printed by the new
  `git-cleanup shell-hook <bash|zsh|fish|pre-commit>` subcommand and
  shipped in the npm package): a bash/zsh/fish hook runs
  `git-cleanup scan --summary` whenever you `cd` into a git repository
  (once per repo per `GIT_CLEANUP_SCAN_INTERVAL`, default an hour), and a
  sample pre-commit hook reminds — never blocks — when branches are
  prunable. Both scan offline and only ever report. `scan --summary` is
  the compact one-line-per-repo mode they use.
- Forge API calls now time out: every provider fetch aborts after
  `GIT_CLEANUP_FETCH_TIMEOUT_MS` (default 15 s) and degrades to an honest
  `PR lookup failed` error, so a dead network can never hang a shell hook,
  cron job, or CI step indefinitely.
- A `.gitlab-ci.yml` template mirroring the GitHub CI: Node 18/20/22 test
  matrix with the 50,000-shape parity sweep, CLI smoke, playground-fresh
  gate, a scheduled seed re-sweep (`FUZZ_SEED = CI_PIPELINE_IID`), and a
  scheduled `scan --check` job that fails the pipeline when branches are
  prunable (GitLab has no Action marketplace, so the CLI is the report
  channel). Structure is pinned by `test/gitlab-ci.test.mjs`; see the
  README "GitLab CI" section.
- CI parity is now pinned both ways: `test/ci-parity.test.mjs` structurally
  checks `.github/workflows/ci.yml` (the same way `test/gitlab-ci.test.mjs`
  checks the template) and asserts the two files cannot drift apart — node
  matrix, fuzz volume, CLI smoke, playground-fresh gate, scheduled sweep,
  and the branch-hygiene report channel must match on both sides.
- The GitLab template gains a scheduled `report-issue` job (GitLab's
  answer to the GitHub scan-report action): it renders the scan with the
  *same* markdown renderer and keeps one issue titled `git-cleanup:
  branch report` current via the Issues API — create or update,
  exact-title match, paginated search — through the CLI's
  `report-issue` command (below).
- Gitea provider: Gitea's API is GitHub-shaped, so the provider reuses
  that dialect for `gitea.com`, `codeberg.org`, and `forgejo.org`
  (`GITEA_TOKEN`, `Authorization: token`, API base per host or
  `GITEA_API_BASE` override): PRs from `GET /api/v1/repos/{o}/{r}/pulls`
  (`state=all`, `sort=recentupdate`), pagination via `Link` header with
  `x-total-count` fallback and the shared 2,000-item truncation cap,
  GitHub-style merge detection (`state: closed` + `merged_at`), and
  `prs --close` via `PATCH` + issue comment. Self-hosted Gitea/Forgejo
  domains are not claimed (no distinctive hostname); the README documents
  this and the config-mapping roadmap. See "Forge support" in the README.
- Issue reporting is now a CLI command: `git-cleanup report-issue
  <report.md> [--title <title>] [--dry-run]` keeps one issue with a fixed
  title current on *any* forge. It reads the repository's remote, picks
  the matching provider (GitHub, GitLab, Bitbucket, Gitea — the same
  hostname detection and tokens as PR enrichment: `GITHUB_TOKEN` /
  `GITLAB_TOKEN` / `BITBUCKET_TOKEN` / `GITEA_TOKEN`, plus the
  `GITHUB_API_BASE` / `GITLAB_API_BASE` / `BITBUCKET_API_BASE` /
  `GITEA_API_BASE` and `CI_API_V4_URL` / `CI_JOB_TOKEN` overrides), and
  creates or updates by exact-title search — GitHub via `Link`-header
  pagination with pull requests excluded, GitLab via a title-narrowed
  `search=` + `in=title` (so the dedup survives huge issue backlogs),
  Bitbucket via embedded `next` pagination, Gitea GitHub-style.
  `--dry-run` rehearses: the same read-only search runs, create-vs-update
  is resolved, only the write is skipped. Both scheduled report jobs (the
  GitHub workflow and the GitLab template's `report-issue`) now rehearse
  with `--dry-run` before the real post, so every run proves the token,
  forge detection, and exact-title search work — a failing rehearsal
  fails the run, and the report is never silently skipped. Re-validating
  the edited template with a real YAML parser also surfaced and fixed a
  latent template bug: `--title "git-cleanup: branch report"` contains a
  `: ` (colon + space), which silently splits an unquoted YAML plain
  scalar into a mapping — the `report-issue` job's script would have been
  rejected by real GitLab. The script lines are now quoted, and a
  structural test guards the whole template against the `: ` trap. This
  consolidates the former
  `support/github/report-issue.mjs` and `support/gitlab/report-issue.mjs`
  scripts — deleted; the scheduled GitHub workflow and the GitLab
  template now call the command directly, so the identical invocation
  works in GitHub Actions, GitLab CI, or any cron. The auth story was
  validated against a real GitLab instance and GitLab's docs: CI/CD job
  tokens cannot write the Issues API by default (GitLab 16+), so
  `GITLAB_TOKEN` (a masked project access token with `api` scope) is the
  documented primary auth and `CI_JOB_TOKEN` a clearly-labeled fallback;
  the read path (pagination, `iid`/`title`/`web_url` fields,
  update-target addressability) was verified against live data. Exported
  from the library (`postReport`, `resolveForgeContext`,
  `DEFAULT_TITLE`) and tested end-to-end against a stubbed API
  (`test/report-issue.test.mjs`).
- `git-cleanup doctor`: one diagnostic pass over the environment — git
  and `gh` presence, every forge token (with the `CI_JOB_TOKEN` GitLab
  fallback), config validity (including `forge.hosts` claims), and how
  each remote of the repo at hand resolves. Missing tokens, a missing
  `gh`, and unrecognized remotes are warnings with fix hints (a
  copy-pasteable `forge.hosts` suggestion); a missing git or a broken
  config are errors that exit 1. `doctor --json` emits the report as one
  machine-readable document. Checks are pure data (`runDoctor`) with an
  injectable spawn so tests are deterministic; the home config path is
  resolved per call so an exported session honors a changed `HOME`.
- `forge.hosts` config: self-hosted GitLab/Gitea instances on custom
  domains (e.g. `git.example.com` running GitLab, a Gitea at
  `git.internal`) can now be claimed by hostname — used by PR tracking
  and `report-issue` alike. An explicit mapping always wins over the
  built-in hostname heuristics; API bases derive from the host
  (`https://<host>/api/v4` GitLab, `https://<host>/api/v1` Gitea) with
  the env overrides (`GITLAB_API_BASE` / `CI_API_V4_URL`,
  `GITEA_API_BASE`) still honored. Unknown forge ids in the map are a
  loud config error. `report-issue` now reads config (for this key);
  detection/parsing takes the map through `detectForge`,
  `providerFor`, `loadPRs`, and the providers' `issues.context`.
  Claiming a host as `github` or `bitbucket` stays possible but their
  parsers only claim `github.com`/`bitbucket.org`, so such claims
  degrade loudly rather than guessing (GitHub Enterprise and Bitbucket
  Server remain unclaimed).
- `backup list` and `backup restore`: the bundle backups behind `-D`
  deletions are now queryable and restorable by name. `backup list`
  prints every bundle (name, date, size, branches it holds, and whether
  the retention sweep would remove it) with the backup dir; `backup
  restore NAME` resolves a bundle by basename (or an explicit path) and
  fetches back every branch ref it holds that does **not** already
  exist locally — exact refspecs, no force, so a restore can never
  clobber current work, and branches that exist are skipped with a
  note. It confirms first (`--yes` for scripts); a missing name is a
  loud error that lists what's available. `backup list --json` prints
  the whole inventory for automation. Restoring is just `git fetch`
  under the hood, so a restored branch can be deleted again with plain
  git. The backup location comes from `backup.dir` config (default the
  repo's `.git/git-cleanup-backups`), and the non-interactive
  confirmation error now says "nothing was restored" instead of the
  prune wording.

### Changed

- The parity fuzz is volume-configurable and CI sweeps it deep: the test
  reads `FUZZ_CASES` (default 2,000 — local `npm test` stays fast) and
  `FUZZ_SEED` (default fixed, so failures stay reproducible). CI runs every
  push and pull request at 50,000 shapes, and a nightly schedule plus
  `workflow_dispatch` re-sweep the seed space on days without pushes. The
  coverage assertions scale with the volume, so the sweep can't go
  vacuously green at any depth.
- README: badges (CI, npm, license, Node), a table of contents, a
  comparison table against other branch cleaners (built-in git, git-sweep,
  git-delete-merged-branches, git-extras, git-clean-gone, GitHub's
  auto-delete setting), and a package-manager table including Homebrew.
- Dead code removed: `gitOk`, `remoteBranchExists`, `isRefProtected`,
  `isoFromUnix`, and the unused `c.cyan`/`c.gray` color helpers.
- The forge provider contract now includes an `issues` capability (context
  resolution, find/create/update, preview URL) implemented by each provider
  in `src/providers/` — GitHub, GitLab, Bitbucket, Gitea. `report-issue`
  became a thin generic loop over that contract (down from ~310 to ~90
  lines), removing its six per-forge case analyses: all forge-specific
  knowledge (tokens, endpoints, pagination dialects, field names, write
  bodies) lives in the provider, so adding a forge is literally "implement
  the contract in a new provider module and register it", for PR tracking
  and report posting alike. `ForgeError` moved to `util.mjs` so providers
  can throw it without an import cycle; `resolveForgeContext` and
  `postReport` behave identically (all 23 behavior tests pass unchanged),
  and a new contract test pins the capability on every registered provider.
- `prune` accepts `--force` as an alias for `--yes` — the word users
  naturally try first (the safety gate is unchanged: it still only skips
  the interactive confirmation, exactly like `--yes`). Completions and
  `--help` updated; regression test added.

## [0.2.8] - 2026-09-05

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
