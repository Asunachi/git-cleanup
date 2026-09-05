# GitHub Marketplace listing — `scan-report`

Paste-ready copy and the exact submission steps for the
`Asunachi/git-cleanup/.github/actions/scan-report` action. Everything the
marketplace form needs is already in `action.yml` (name, description,
author, branding icon/color, documented inputs and outputs), so the form
mostly needs copy you paste in.

## Submission steps (one-time, ~2 minutes)

1. Sign in as `Asunachi` and open **https://github.com/marketplace/new**.
2. Accept the **GitHub Marketplace Developer Agreement**.
3. Select **Asunachi/git-cleanup** as the publishing repository. The form
   auto-fills the action name and description from `action.yml` — verify
   they look right.
4. **Categories** (choose one; two allowed): **Utilities** (primary —
   branch cleanup/pruning) and **Continuous integration** (secondary — it
   runs as a scheduled report in CI). Both fit; Utilities is the better fit
   for search.
5. **Short description** (shown on the marketplace card):
   Scan for prunable/stale git branches and post an unattended weekly report.
6. **Long description** — paste the markdown below.
7. **Support URL**: `https://github.com/Asunachi/git-cleanup/issues`
8. **Publish**. The listing appears under
   `https://github.com/marketplace/actions/<slug>`.

After publishing, nothing else to maintain: the marketplace reads version
tags from the repo automatically, so every future `vX.Y.Z` release updates
the listing without a resubmission.

## Long description (markdown)

```markdown
**git-cleanup scan-report** runs `git-cleanup` on a schedule and keeps you
informed about branch debt — automatically, in the background, with zero
installs on any developer machine.

It scans your repository for branches that are safe to prune (merged,
squash/rebase-merged, or abandoned) and branches worth reviewing (stale),
then posts the report to a single issue that stays current week after week —
or to the Actions log/step summary when you don't want an issue at all.

**Why git-cleanup:** plain `git branch --merged` misses squash and rebase
merges — the most common way GitHub merges pull requests. git-cleanup
fingerprints a branch's final content against base history, so
squash-merged branches are recognized even though their commits were
rewritten. It is conservative: protected/base/checked-out branches are
never touched, unmerged work is never deleted without an explicit force
rule, and every force deletion writes a recoverable git bundle first.

**Works on CI checkouts:** a shallow checkout (the Actions default) hides
the history merge detection needs, so the action fetches full history
first and scans with the same truth a local clone would see. Merge
detection itself is fully offline; PR state is a best-effort enrichment
on top.

### What you get

- A weekly (or on-demand) **branch report issue** — one issue, updated in
  place, not a new issue per run.
- **Machine-readable output** (`prunable`, `stale`, `kept`, `errors` as
  action outputs) for your own checks.
- The CLI behind it (`git-cleanup`) for interactive pruning:
  `npx -y @maliqkara/gitcleanup@latest` — or a live playground at
  https://asunachi.github.io/git-cleanup/ to see the decision engine in
  action before adopting anything.

### Usage

```yaml
on:
  schedule:
    - cron: "0 3 * * 1"     # weekly
  workflow_dispatch:

permissions:
  contents: read
  issues: write             # required for the report issue

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: Asunachi/git-cleanup/.github/actions/scan-report@v0.2.6
        with:
          path: .
          report: issue
          issue-title: "git-cleanup: branch report"
```

Six lines and your repo gets a weekly, unattended audit of its own branch
debt. Pin by release tag (`@vX.Y.Z`); see the README for the full option
set (`path`, `unshallow`, `report`, `issue-title`, `token`).
```