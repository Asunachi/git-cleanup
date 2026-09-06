# Contributing

Thanks for helping out! This project is intentionally small and dependency-free:
a Node.js CLI that shells out to `git` and never touches `.git` internals.

## Requirements

- Node.js >= 18
- `git` on your PATH (tests build real throwaway repositories in the OS temp dir)
- GitHub access (`gh` CLI or a `GITHUB_TOKEN`) only if you work on PR features

## Getting started

```bash
npm test          # node --test: unit + integration + fuzz tests
npm run coverage  # same suite under --experimental-test-coverage → coverage.json
npm run lint      # zero-dependency lint (also runs inside npm test)
node bin/git-cleanup.mjs scan   # try it against a git repo you own
```

There is no build step and no `npm install` — the code runs on Node built-ins
only. Please keep it that way unless there is a very strong reason not to.
The linter (`scripts/lint.mjs`) is dependency-free: it syntax-checks every
JS file and enforces no-tabs / no-trailing-whitespace / final-newline, and it
runs as part of `npm test`, so a lint violation can never go green.

The README's coverage badge is generated the same dependency-free way:
`npm run coverage` runs the suite under Node's built-in
`--experimental-test-coverage` (needs Node ≥ 21; measure only `src/`,
never the tests) and writes `coverage.json`, the shields.io payload behind
the badge, plus `coverage-raw.json` with the precise percentages. You
never commit those files — the Pages deploy
(`.github/workflows/pages.yml`) recomputes them on every main push and
serves them from the site, so the badge always matches the published tree.
Locally `npm run coverage` is useful to spot untested paths before
pushing: it prints the per-file table, and the precise numbers are in
`coverage-raw.json`.

CI enforces the number too: the `coverage-gate` job in
`.github/workflows/ci.yml` re-measures coverage the same way (Node 22,
default fuzz volume — the same environment as the Pages deploy, so
numbers are comparable) and fails a PR or push whose `src/` line coverage
drops below the last deployed baseline. It is GitHub-only by design: the
baseline is this repository's deployed site, which other projects' copies
of `.gitlab-ci.yml` don't have. Adding a file to `src/` without tests will
fail the gate — add the tests in the same change.

## Code layout

- `src/git.mjs` — all `git` plumbing (branch enumeration, merge detection,
  upstream/base resolution). No shell scripts; `git` is spawned directly.
- `src/engine.mjs` — the pure, dependency-free decision engine (glob matching,
  `classify`, `classifyRemote`, and `classifyBranch`, the full per-branch
  layering `analyze.mjs` applies). Single source of truth: `classify.mjs` and
  `util.mjs` re-export it, and the playground bundles it verbatim.
- `src/classify.mjs` — config defaults plus re-exports of the engine.
- `src/analyze.mjs` — gathers one repo's state and classifies every branch.
- `src/config.mjs` — config discovery and layering.
- `src/forge.mjs` — forge abstraction: provider registry, remote detection by
  hostname, and the shared PR shape consumed by everything else. The
  contract includes each provider's `issues` capability (context, find /
  create / update / preview URL), which `report-issue` loops over.
- `src/providers/github.mjs` — the GitHub provider behind that contract (`gh`
  CLI, then REST fallback, plus the `issues` capability). New forges
  (GitLab, Bitbucket, Gitea) add a sibling here and register in `forge.mjs`
  — nothing outside the provider needs to change for `report-issue`.
- `src/report-issue.mjs` — the `report-issue` command as a thin generic loop
  over the provider `issues` contract (all forge-specific logic lives in the
  providers).
- `src/prune.mjs` — deletion with confirmation guards.
- `src/report.mjs` / `src/cli.mjs` — rendering and command-line interface.
- `test/` — unit tests plus integration tests against throwaway repos
  (`support/helpers.mjs` holds the repo-building fixtures; it lives outside
  `test/` so Node's test runner doesn't count it as a test file).
- `support/completions/` — the bash/zsh/fish completion scripts printed by
  `git-cleanup completions <shell>`; they ship in the npm tarball.
- `support/dotfiles/` — the shell-hook and pre-commit snippets printed by
  `git-cleanup shell-hook <kind>`; also shipped in the npm tarball.
- `homebrew-git-cleanup/` — the dedicated Homebrew tap repository: the
  formula plus its auto-update workflow (`update-formula.sh`, scheduled
  daily in `.github/workflows/update-formula.yml`, plus a `RELEASE_PR=1`
  mode that bumps on a branch and files a pull request). The directory is
  the content of `github.com/Asunachi/homebrew-git-cleanup` (tap name
  `Asunachi/git-cleanup`); push it there as its own repo. This repository
  deliberately ships no formula of its own, so the two can't drift.
- `support/release/bump-version.mjs` — the dependency-free version-bump
  engine behind the `release` workflow: semver math (patch/minor/major or
  `exact=`), a tag-reuse guard, and the tap-formula re-seed whose sha256
  comes from `npm pack` of the release tree.
- `.github/workflows/release.yml` — the one-button release pipeline
  (manual dispatch): test suite → bump → tag → push → GitHub Release →
  tap PR. Its shape is pinned by `test/release-workflow.test.mjs`; the
  bump engine by `test/release.test.mjs`; the tap updater's release modes
  by `test/tap-pr-mode.test.mjs`.
- `scripts/sync-playground.mjs` — bundles `src/engine.mjs` into `index.html`
  (run `npm run sync:playground` after editing the engine).
- `index.html` — a standalone documentation page with interactive demos that
  run the real engine. Don't hand-edit between the `__ENGINE__` markers:
  regenerate with `npm run sync:playground`. The page pins its suite size in
  two spots (header badge + run-it-yourself snippet); if you add or remove
  tests, the parity test (`test/playground-parity.test.mjs`) will tell you
to update them.

## Making changes

1. Open an issue or PR describing what you're changing and why.
2. Keep changes scoped. Add a test for anything you fix.
3. Run `npm test` — everything must pass (it includes the linter).
4. If you touched the decision logic (`src/engine.mjs`), run
   `npm run sync:playground` to re-bundle it into the demo page and commit
   the result — CI enforces this twice: `test/playground-parity.test.mjs`
   fails if the page's copy drifts, and the `playground-fresh` job fails the
   build if the committed bundle isn't the output of the sync script.
5. If you changed CLI surface (flags, subcommands), update `--help`
   (`src/cli.mjs` USAGE), the completion scripts
   (`support/completions/`), and the README's usage examples.
6. If you added or removed tests, the page's test-count badge must be
   updated to match (the parity test enforces it).
7. If you changed CI behavior in `.github/workflows/ci.yml` (test matrix,
   smoke checks, freshness gates), mirror the change in the
   `.gitlab-ci.yml` template — `test/ci-parity.test.mjs` pins both files'
   structure and asserts they cannot drift apart (node matrix, fuzz volume,
   smoke steps, freshness gate, scheduled sweep), and
   `test/gitlab-ci.test.mjs` pins the template's jobs. The same rule
   applies to the scheduled report channel: `test/ci-parity.test.mjs`
   asserts `.github/workflows/report-issue.yml` ↔ the template's
   `report-issue` job (schedule, command, renderer, issue title), so a
   change to either side must be mirrored in the other. Before merging a
   change to `.gitlab-ci.yml`, also run it through GitLab's CI Lint
   (CI/CD → Pipelines → CI Lint): the structural tests catch indentation
   and command existence, not runner-side semantics.
8. Document user-visible changes under `[Unreleased]` in `CHANGELOG.md`
   (Keep a Changelog + semver).

## Design constraints to respect

- **Safety first.** Unmerged work is never deleted unless a user-configured
  force rule matches, and deletions require confirmation (or `--yes`).
  Anything that weakens this needs a strong justification.
- **Zero dependencies.** Reviewers will reject new runtime packages without a
  compelling reason.
- **Offline by default.** Merge detection must work without a network; GitHub
  data is a best-effort enrichment layered on top.

## Releasing

The npm package is published as **`@maliqkara/gitcleanup`** (the unscoped
name `git-cleanup` is held by an unrelated project and npm blocks
lookalikes); the CLI command stays `git-cleanup`. npm history starts at
0.2.0; `CHANGELOG.md` and `package.json` always carry the same version.

Releases are driven by the **`release` workflow**
(`.github/workflows/release.yml`, manual dispatch only — releases are
deliberate acts). It runs the full test suite, bumps the version, tags and
pushes, publishes the GitHub Release, **publishes to npm with Sigstore
provenance**, and files the Homebrew tap update as a pull request. A
`dry_run` input rehearses the entire pipeline without changing anything.

The npm publish now happens **in CI**, not on a laptop: `npm publish
--provenance` needs the OIDC token GitHub mints for a workflow run, which a
local publish can never carry — so the registry artifact is verifiably the
output of this workflow on the release commit, and the tarball always comes
from the Node 26 the workflow pins for packing (same zlib → the formula
sha256 always matches; the old “publish from Node 26 or re-pin” caveat is
gone by construction).

1. Write the release notes first: move the matching `[Unreleased]` content
   in `CHANGELOG.md` into a dated entry and commit it, and update every
   GitHub Action pin to the new tag in the same commit: the README example
   (`scan-report@vX.Y.Z`), `docs/launch-post.md`, and `docs/marketplace.md`
   wherever they show one. The pins must land in the release tree so the
   tag itself carries them. The companion repos take care of themselves:
   `Asunachi/git-cleanup-action` re-pins via its `update-pin` workflow
   (daily drift check → PR), and `Asunachi/gh-git-cleanup` tracks `@latest`
   by design — nothing to do for either.
2. Set the two repository secrets once (Actions → Settings → Secrets and
   variables):

   - **`NPM_TOKEN`** — an npm *automation* token (npmjs.com → Access
     Tokens → *Granular Access Token*), scoped to `@maliqkara/gitcleanup`
     only, with the publish-only permission and 2FA bypass ticked when the
     account has two-factor auth enabled. Until it is set, the workflow's
     publish job fails loudly and nothing ships — by design.
   - **`TAP_REPO_TOKEN`** — a fine-grained PAT with *Contents: Read and
     write* + *Pull requests: Read and write* on
     `Asunachi/homebrew-git-cleanup` only (a full-scope PAT works but is
     not recommended). Without it the workflow fails at the tap checkout —
     loudly, before anything is pushed.

   ```bash
   gh secret set NPM_TOKEN --repo Asunachi/git-cleanup
   gh secret set TAP_REPO_TOKEN --repo Asunachi/git-cleanup
   ```

3. Dispatch the **release** workflow (Actions → release → Run workflow)
   with `version_bump` (patch/minor/major) or `exact_version` — or
   `dry_run: true` first to rehearse. The workflow:
   - runs `npm test`;
   - bumps `package.json` and re-seeds the tap formula scaffold
     (`support/release/bump-version.mjs`; the sha256 comes from `npm pack`
     of the release tree — deterministic for a fixed Node version, so the
     workflow pins Node 26 for its packing steps and its publish job);
   - commits `Release X.Y.Z`, tags `vX.Y.Z` (annotated), and pushes both
     — which triggers `release-check` and the Pages deploy automatically;
   - creates the GitHub Release from the tag;
   - publishes to npm (`npm publish --provenance --access public` with
     `id-token: write`, Node 26, from the tag) — the full test suite runs
     again via `prepublishOnly` before upload;
   - files the tap PR against `Asunachi/homebrew-git-cleanup` via the
     tap's own `update-formula.sh` in PR mode (`RELEASE_PR=1`), hashing
     the release tree directly. It runs only after the npm publish
     succeeds (`needs: publish-npm`), so the PR is never filed for a
     version that did not reach the registry.

   You can verify the published package's provenance with `npm view
   @maliqkara/gitcleanup@<version> provenance` — it prints the builder,
   the source repo, and the exact commit the tarball was built from.
   `npm publish --dry-run` locally is still a useful pre-flight (it runs
   the suite and lists the tarball contents), but it does not upload.
5. **Verify the tarball on every OS before announcing the release.** The
   `release-check` workflow (`.github/workflows/release-check.yml`) runs
   automatically when the `v*` tag is pushed: it packs the exact tree the
   tag points at, installs the tarball into a temp prefix, and runs the
   installed CLI (`--version`, `--help`, and a real `scan --check`) on
   Linux, macOS, and Windows. Wait for all three jobs to pass before
   announcing. To check a tree *before* publishing (or to re-run), use
   Actions → **release-check** → *Run workflow* on any branch.
6. Merge the tap PR (or close it — the tap's daily poll picks the release
   up on its own; the PR exists so releases are reviewable before `brew`
   users get them). If the action is published on the GitHub Marketplace,
   the listing updates automatically from the new tag — nothing to
   resubmit (see `docs/marketplace.md`).

### Tagging past releases

npm versions can outlive their tags: `v0.2.1` (the first npm-published
version) was tagged at `e275e99` only after later work had already landed on
`main`. To tag an older published version retroactively, find the commit
whose tree was published (its `package.json` shows that name + version) and
run `git tag -a vX.Y.Z <sha> && git push origin vX.Y.Z`, then create its
GitHub Release. The retroactive tag push also triggers `release-check`, so
wait for that workflow to pass on the old tree before creating the Release.
Note that `v0.2.1`'s tree predates the GitHub Action, so `@v0.2.1` pins a
CLI-only snapshot — `v0.2.2` (which ships the action) is the earliest tag
that resolves `Asunachi/git-cleanup/.github/actions/scan-report`.
