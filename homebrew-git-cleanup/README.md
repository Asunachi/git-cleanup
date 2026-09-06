# homebrew-git-cleanup

The Homebrew tap for **[git-cleanup](https://github.com/Asunachi/git-cleanup)** —
a zero-dependency CLI that prunes stale/merged Git branches with pull-request
awareness.

Homebrew taps must live in a `homebrew-`-prefixed repository, so this
repository exists purely to host the formula; the software itself lives in
[Asunachi/git-cleanup](https://github.com/Asunachi/git-cleanup) and is
published to npm as `@maliqkara/gitcleanup`. The formula installs the exact
npm tarball of the pinned release — there is no build step, and the only
dependency is Node.js.

## Install

```bash
brew tap Asunachi/git-cleanup
brew install git-cleanup
```

The fully qualified form (`brew install Asunachi/git-cleanup/git-cleanup`)
works too. Formula changes land automatically: this repository's
`update-formula` workflow checks [Asunachi/git-cleanup](https://github.com/Asunachi/git-cleanup)
for new releases every day at 04:17 UTC and rewrites the pinned version and
sha256 when one appears — no manual release chore.

To pull a just-published release immediately instead of waiting for the next
poll: **Actions → update-formula → Run workflow** in this repository.

## Layout

| Path | Purpose |
| --- | --- |
| `Formula/git-cleanup.rb` | The formula. `url` points at the npm registry tarball for the pinned version; `sha256` is that tarball's digest. Both are rewritten by the update workflow. |
| `.github/workflows/update-formula.yml` | Scheduled + manual workflow that calls `update-formula.sh` and pushes the bump. |
| `update-formula.sh` | The bump logic, standalone so it can be reviewed and rehearsed locally. |

## How the formula stays current

1. `update-formula.sh` resolves the newest `vX.Y.Z` tag of
   `Asunachi/git-cleanup` via the GitHub API — or an explicit `RELEASE_TAG`
   when one is supplied. Tags drive the bump (the project releases by tag);
   GitHub Release objects are optional and not required.
2. It compares that version against the formula's current one and does
   nothing when the formula is already current or newer.
3. Otherwise it downloads the npm tarball that release publishes and
   replaces `url` + `sha256` in the formula.
4. It commits (`git-cleanup X.Y.Z`) and pushes with the repository's
   automatic `GITHUB_TOKEN` — no secrets or cross-repo tokens involved.

You can rehearse a bump locally from this repository's root:

```bash
# What would change if a release tag were bumped to v0.4.0?
RELEASE_TAG=v0.4.0 DRY_RUN=1 ./update-formula.sh

# Against whatever the latest upstream release is:
DRY_RUN=1 ./update-formula.sh
```

## Verifying a formula change

Homebrew's own check is a real install:

```bash
brew install --build-from-source ./Formula/git-cleanup.rb
```

The formula's `test` block also runs on every `brew install` and asserts
`git-cleanup --version` prints the pinned version and `--help` lists `scan`.

## License

MIT — see [LICENSE](LICENSE). The formula is MIT like the software it
installs.
