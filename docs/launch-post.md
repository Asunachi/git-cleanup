<!--
  Launch post for git-cleanup (https://github.com/Asunachi/git-cleanup).
  Publish as-is or adapt; suggested titles per venue:

  - Show HN / lobste.rs: "I ran a dead-branch detector on 91 real branches from
    famous repos — here's what it caught that git branch --merged can't"
  - r/programming / r/node / r/git: "Your repo is a branch graveyard — and most
    cleanup tools can't see half the bodies"
  - dev.to / personal blog: "What squash merges do to your Git history (and how
    to detect the branches they hide)"

  Facts below come from the repo's soak test and are verified in the README /
  CHANGELOG. Link everything back to the repo and the live playground:
  https://asunachi.github.io/git-cleanup/
-->

# Your repo is a branch graveyard — and most cleanup tools can't see half the bodies

Every repo that has been through more than a couple of feature cycles has
them: the branches nobody merged, the ones merged *so long ago* nobody
remembers, and the silent killer — branches whose work is already in `main`,
but in a form Git can't recognize.

The standard advice — `git branch --merged` — only catches one kind of dead
branch: the one whose commits are literally ancestors of your base. That
advice misses an enormous class of them, because of something most teams do
every single day.

## Squash merges hide dead branches from Git

When you squash-merge a pull request (GitHub's default for many teams), the
feature's commits are rewritten into one new commit. The branch's original
commits vanish from history. From Git's point of view, that branch looks
*unmerged forever* — its tip is nowhere in `main`, so `git branch --merged`
won't flag it, and it accumulates in your local repo until someone notices
they have forty branches and can't remember which ones are real.

This is where I started. I built a small CLI that doesn't stop at ancestry.
It fingerprints each branch's **final state** — its tree — and checks whether
that tree already exists anywhere in the base branch's history. Squash merge?
Rebase merge? Cherry-picked rewrite? If the content is already in `main`, the
branch is dead, and the tool can prove it.

## The experiment: 91 real branches, six famous repos

A detector that only works on toy examples is worthless, so I ran it against
six popular open-source repositories with real accumulated branch debris —
among them **Express, Lodash, Vue, Moment, and Prettier** — about 91 branches
in total, and cross-checked *every single verdict* independently, with raw
Git commands and live GitHub data.

The result: **zero wrong calls.** Every branch the tool wanted to delete was
independently verified as genuinely dead. Every branch it said was stale was
checked for hidden merges. And it found things plain ancestry checks can't:

- **Express's `feat/fresh-query-method`** was flagged as merged via content.
  GitHub confirms it was squash-merged with **no pull request ever existing**.
  No PR lookup would ever have caught it. Content detection did.
- Repos with unusual defaults (`moment` lives on `develop`, `express` on
  `master`) were resolved correctly, offline, from the remote itself.
- The tool caught its own blind spot during the test — a phantom "branch"
  that Git's ref naming creates on every normal clone — which is now fixed and
  covered by regression tests.

That last part is the part I'm most proud of: the test was designed to find
wrong verdicts, and the honest finding was "none in the engine, one in my own
tooling."

## The uncomfortable finding (read this before deleting remotely)

The soak also exposed the one judgment call that no detector can make: real
maintenance branches. Express's `5.x` and Prettier's `v3.8.x` are *merged by
ancestry* — their commits all live in the default branch — and older than the
age threshold, so the tool correctly says "safe to delete locally." And it is.
But deleting them *remotely* would remove branches upstream still owns. The
tool handles this correctly by making remote deletion a separate, opt-in step
(`--remote`) — and the docs tell you to protect version-shaped branches with a
two-line glob before you point it at your remote.

## What it actually does

- **`scan`** — a table of every branch with its verdict: `PRUNE` (dead),
  `stale` (needs a human), `keep` (protected, has an open PR, or too young) —
  and the *reason* for each. Machine-readable JSON for scripts.
- **`prune`** — deletes nothing without confirmation. Before any deletion
  that loses unique commits (squash merges, force rules, remote branches) it
  writes the refs into a **git bundle** first — one `git fetch` restores
  anything. Retention policy cleans up old bundles on a schedule.
  If Git refuses a plain `-d` because a branch is merged into a remote base
  but not your local `HEAD` — the stale-local-default-branch trap — the
  tool doesn't dead-end and tell you to re-run later: it already proved the
  tip is an ancestor of a base ref, so it writes the safety bundle and
  force-deletes, and says so on the way out. The bundle is the answer to
  "what if you're wrong?" — you aren't, and if you were, it's one `git
  fetch` away.
- **`prs`** — the stale-PR automator: lists and optionally closes PRs that
  have been silent for months.
- **GitHub and GitLab** PR state cross-reference (`gh`, `GITHUB_TOKEN`, or
  `GITLAB_TOKEN`), degrading gracefully to pure-Git detection offline.
- **Zero dependencies.** Node ≥ 18, the `git` binary, and nothing else. 69
  tests, green on Linux, macOS, and Windows — including worktree, empty-repo,
  and cross-platform path edge cases.

## Try it in 10 seconds

```bash
npm install -g @maliqkara/gitcleanup
cd ~/your/repo && git-cleanup scan
```

## Or don't install anything — let a bot do it weekly

This is the part I think most repos will actually want. A **GitHub Action**
(`scan-report`) that runs on a schedule, detects the branch debt your CI
checkout hides, and keeps a single report issue up to date — created on the
first run, updated in place every week:

```yaml
on:
  schedule:
    - cron: "0 3 * * 1"
permissions:
  issues: write
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: Asunachi/git-cleanup/.github/actions/scan-report@v0.2.8
        with:
          report: issue
```

Six lines, and your repo gets a weekly, unattended audit of its own branch
debt — no installs on any developer machine.

There's also a **[live playground](https://asunachi.github.io/git-cleanup/)**
where you can drag the age thresholds and watch the real decision engine
classify a simulated repo in your browser.

The uncomfortable question every repo eventually faces isn't "should I delete
dead branches" — it's "which ones are actually dead?" That's the question
`git-cleanup` was built to answer, and it's the one Git itself can't.

---

*git-cleanup — [GitHub](https://github.com/Asunachi/git-cleanup) ·
[npm](https://www.npmjs.com/package/@maliqkara/gitcleanup) ·
[playground](https://asunachi.github.io/git-cleanup/) · MIT licensed*
