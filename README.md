# git-cleanup

[![CI](https://github.com/Asunachi/git-cleanup/actions/workflows/ci.yml/badge.svg)](https://github.com/Asunachi/git-cleanup/actions/workflows/ci.yml)

A zero-dependency CLI that keeps your Git workspace pristine: it scans local
and remote branches, cross-references each branch's activity (last commit,
merge status, upstream state) with its pull-request status on GitHub, then
safely prunes what is genuinely dead — merged branches past an age threshold,
abandoned remote branches, and scratch branches you opted into deleting.

Built on the `git` binary only (never touches `.git` internals) with optional
GitHub enrichment via `gh` CLI or `GITHUB_TOKEN`. Requires **Node.js ≥ 18**.

```
$ git-cleanup scan
$ git-cleanup prune            # deletes nothing without confirmation
$ git-cleanup prune --remote   # also git push --delete on merged branches
$ git-cleanup prs --close      # stale open PR automator
```

## Install

The npm package is **`@maliqkara/gitcleanup`** (the unscoped name
`git-cleanup` is held by an unrelated project, and npm blocks lookalikes);
the CLI command stays `git-cleanup`.

```bash
npm install -g @maliqkara/gitcleanup   # adds the `git-cleanup` command to PATH

# then, inside any git repository:
git-cleanup scan
```

No dependencies to install — you can also run straight from a checkout:

```bash
git clone https://github.com/Asunachi/git-cleanup.git
cd git-cleanup
node bin/git-cleanup.mjs scan
```

## Safety model

Nothing is ever deleted automatically. Decisions are conservative:

| Verdict | What it means | What it takes to delete |
| --- | --- | --- |
| **PRUNE** | Merged into a base branch and older than the threshold (or matched an explicit rule) | `git-cleanup prune` + confirmation |
| **stale** | Unmerged and untouched for a long time, or an abandoned PR | never deleted automatically; review in `scan` |
| **kept** | Protected (see below), the checked-out branch, a base branch, an open PR, or simply too young | — |

* Merged = the branch tip is an ancestor of a base branch. Base branches are
  each remote's default branch (resolved offline via `origin/HEAD`, the
  checked-out branch's upstream, or well-known names like `main`). Unmerged
  work is **never** deleted unless it matches a `mode: "any"` force rule you
  wrote yourself.
* Squash/rebase merges are detected by **content**: when a branch's tip tree
  already exists somewhere in a base branch's history, the branch is treated
  as merged even though its commit SHAs were rewritten. Because ancestry is
  absent those refs are removed with `-D` — safe here, since every file of
  the branch already lives in the base branch. Net-empty branches (no-op
  commits, fully reverted work) are excluded: the matching tree must differ
  from the tree at the branch's own starting point.
* Protected by default: `main master develop dev release release/** staging
  qa trunk`, every base branch, the currently checked-out branch, and anything
  matching your `protected` list. A remote branch is protected by the same
  names (`release/**` protects `origin/release/v1`).
* Local cleanup uses `git branch -d` for ancestor merges; squash/rebase-merged
  and force-rule branches are removed with `-D` (content preserved in the
  base, or explicitly opted in), each behind its own confirmation.
* Remote cleanup only runs with `--remote` and only for merged branches
  (configurable via `remote.pruneMerged`) or PR-abandoned branches
  (`remote.deleteAbandonedAfterDays`).
* In a non-interactive session (no TTY), prune refuses to run without `--yes`.

## Usage

### `git-cleanup scan` (default command)

Reports every branch that could be cleaned up and every stale one worth a look:

```
$ git-cleanup scan --verbose

📦 /path/to/repo
base: origin/main   HEAD: main
  STATUS  BRANCH                       TYPE    AGE   MERGED  PR              REASON
  PRUNE   feature/merged-old           local   60d   yes     merged #12      merged into base
  PRUNE   origin/feature/merged-old2   remote  50d   yes     -               merged into base
  stale   wip/abandoned                local   100d  -       closed #4        unmerged and stale
  ...
  3 prunable · 2 stale · 5 kept
  → git-cleanup prune  /  git-cleanup prune --remote to delete them
```

Without `--verbose` only PRUNE/stale rows are shown. `--json` emits the full
machine-readable report (see “Automation”). For CI, `--check` exits with
code **2** when anything is prunable:

```bash
git-cleanup scan --check --json && echo "workspace is clean"
```

### `git-cleanup prune`

Prints the candidates, then asks before deleting, grouped by risk:

1. ancestor-merged local branches (default answer **yes**),
2. squash/rebase-merged local branches — content provably exists in a base
   branch (default **yes**; net-empty or coincidentally-matching branches are
   never flagged),
3. unmerged branches matched by force rules (default **no**),
4. merged/abandoned remote branches when `--remote` is passed (default **yes**,
   only offered with `--remote`).

Pass `--yes` (or set `GIT_CLEANUP_YES=1`) to run non-interactively. Remote
deletion is `git push <remote> --delete <branch>`.

### `git-cleanup prs` — the stale PR automator

Lists open pull requests with no activity for `pr.staleAfterDays` (default 30):

```
$ git-cleanup prs
📦 /path/to/repo  (org/repo)
  • #412 61d  Upgrade the widget parser  [draft]
```

To actually close them (with a comment), opt in twice — via config
(`"closeStaleAfterDays": 60`) and the `--close` flag:

```bash
git-cleanup prs --close        # asks first
git-cleanup prs --close --yes  # for a nightly cron
```

Only open PRs older than `closeStaleAfterDays` (falls back to
`staleAfterDays`) are closed. Closing PRs never deletes branches — run
`git-cleanup prune` separately for that.

## GitHub integration

PR state enriches the scan but never deletes anything by itself: an open PR
keeps its branch alive, a merged or closed PR is shown for context, and a PR
closed without merging can flag a remote branch as abandoned when you enable
`remote.deleteAbandonedAfterDays`. Deleting a branch always requires git
evidence — its tip is an ancestor of a base branch, or its final tree
already exists in base history (the squash/rebase fingerprint) — or an
explicit force rule.
git-cleanup queries GitHub, in order:

1. the **`gh` CLI** if installed and authenticated, or
2. the **GitHub REST API** if `GITHUB_TOKEN` is set.

Without either, PR columns show `-` and cleanup falls back to pure git merge
detection (this is what runs in the tests and works fully offline). Only
GitHub remotes are queried; other remotes are ignored.

## Configuration

Config files merge in this order (later wins):

1. built-in defaults
2. `~/.config/git-cleanup/config.json`
3. `.gitcleanup.json` (or `.git-cleanup.json`), found by walking up from the
   current directory — perfect for per-repo rules
4. a file passed via `--config <file>`

```jsonc
{
  // Globs never touched, on top of the built-in protected list.
  "protected": ["special/release", "vendor/**"],

  // Merged branches older than this (days, from the tip commit) are prunable.
  "deleteMergedAfterDays": 21,

  // Unmerged branches older than this are flagged as stale (never deleted).
  "warnUnmergedAfterDays": 45,

  // Per-name rules. mode "merged" = custom age for merged branches;
  // mode "any" = force-delete even when unmerged (local only — opt in!).
  "rules": [
    { "match": "feature/ci-*", "mode": "merged", "minAgeDays": 7 },
    { "match": "tmp/**", "mode": "any", "minAgeDays": 1 }
  ],

  "pr": {
    "track": true,
    "staleAfterDays": 30,
    "closeStaleAfterDays": 60,
    "closeComment": "Auto-closed by git-cleanup — reopen if still needed."
  },

  "remote": {
    "pruneMerged": true,
    "deleteAbandonedAfterDays": 0 // >0 enables deleting remote branches whose PR closed unmerged
  },

  // Scan more than one repository at once (paths resolve relative to this file).
  "repos": ["../other-project", "/srv/legacy"]
}
```

Rule semantics: the first matching rule for a branch wins. `mode: "merged"`
rules only fire for merged branches and use `minAgeDays` (default:
`deleteMergedAfterDays`); an unmerged branch matching one is kept with reason
`unmerged-rule`. `mode: "any"` rules fire on unmerged branches too with
`minAgeDays` defaulting to 0 — pair them with a meaningful age unless you
really want same-day scratch deletion, and note they can only affect local
branches.

## Automation / exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | error (bad config, not a git repo, failed delete, etc.) |
| 2 | `scan --check` found prunable branches |

Nightly cleanup via cron/CI (adjust with care — read the safety model first):

```bash
git-cleanup scan --check --json > /tmp/cleanup.json
git-cleanup prune --yes
git-cleanup prs --close --yes   # only if you configured closeStaleAfterDays
```

`--json` output is a single document with one entry per repo; every branch
carries `verdict` (`delete` | `warn` | `keep`), `reason`, `ageDays`, `merged`,
`orphan`, and PR info when available. Stable for piping into your own tooling.

## GitHub Action: unattended scan reports

A composite action (`Asunachi/git-cleanup/.github/actions/scan-report`) runs
`git-cleanup scan` on a schedule and keeps a single report issue up to date,
so branches that go stale while nobody is looking still get seen:

```yaml
name: branch report

on:
  schedule:
    - cron: "0 3 * * 1"     # weekly
  workflow_dispatch:

permissions:
  contents: read
  issues: write             # required to create/update the report issue

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Asunachi/git-cleanup/.github/actions/scan-report@main
        with:
          path: .
          report: issue
          issue-title: "git-cleanup: branch report"
```

Pin to a release tag (e.g. `@v0.2.2` once cut) rather than `@main` if you
want the action frozen to a specific version.

**Shallow checkouts are handled automatically.** CI clones default to
`fetch-depth: 1`, which hides history from merge detection (both ancestor
and squash/rebase checks). The action detects that, fetches full history
(`git fetch --unshallow`) with an explicit refspec covering every remote
branch, and only then scans — set `unshallow: "false"` if your checkout
step already uses `fetch-depth: 0`. If unshallowing fails the action warns
and still reports, but merge detection may be incomplete.

Inputs: `path` (default `.`), `unshallow` (default `true`), `report`
(`issue` keeps one issue with the exact `issue-title` updated per run,
`none` logs only), `issue-title`, `token` (defaults to `GITHUB_TOKEN`).
Outputs: `prunable`, `stale`, `kept`, `errors`, `issue-number`; the full
markdown report is also written to the step summary. Run it on a schedule
or `workflow_dispatch` against the default branch — on pull-request events
the checkout is the merge ref and the scan is less meaningful.

## Development

```bash
npm test   # node --test: unit + integration against real throwaway repos
```

Integration tests build a bare `origin` and a working clone with old merged
branches, an orphaned branch, stale unmerged work, and protected branches,
then assert `scan`, `prune`, and the CLI end-to-end (including `--check`
exit codes).

## Limitations & roadmap

* GitHub-only for PR data (Bitbucket/GitLab remotes work for git-based
  cleanup; PR enrichment is skipped).
* Age is measured from the tip commit of each branch.
* Merge detection is ancestry- or content-based (tip tree found in base
  history), which covers squash and rebase merges. It cannot detect merges
  whose code changed afterwards (e.g. cherry-picks that were amended), which
  is why PR status and your review of `stale` rows matter.
