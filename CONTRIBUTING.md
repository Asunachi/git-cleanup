# Contributing

Thanks for helping out! This project is intentionally small and dependency-free:
a Node.js CLI that shells out to `git` and never touches `.git` internals.

## Requirements

- Node.js >= 18
- `git` on your PATH (tests build real throwaway repositories in the OS temp dir)
- GitHub access (`gh` CLI or a `GITHUB_TOKEN`) only if you work on PR features

## Getting started

```bash
npm test          # node --test: unit + integration tests
node bin/git-cleanup.mjs scan   # try it against a git repo you own
```

There is no build step and no `npm install` — the code runs on Node built-ins
only. Please keep it that way unless there is a very strong reason not to.

## Code layout

- `src/git.mjs` — all `git` plumbing (branch enumeration, merge detection,
  upstream/base resolution). No shell scripts; `git` is spawned directly.
- `src/classify.mjs` — the decision engine and config defaults.
- `src/analyze.mjs` — gathers one repo's state and classifies every branch.
- `src/config.mjs` — config discovery and layering.
- `src/github.mjs` — optional PR enrichment (`gh` CLI, then REST fallback).
- `src/prune.mjs` — deletion with confirmation guards.
- `src/report.mjs` / `src/cli.mjs` — rendering and command-line interface.
- `test/` — unit tests plus integration tests against throwaway repos.
- `index.html` — a standalone documentation page with interactive demos that
  mirror the CLI logic; keep it in sync when `classify.mjs` / `util.mjs` change.

## Making changes

1. Open an issue or PR describing what you're changing and why.
2. Keep changes scoped. Add a test for anything you fix.
3. Run `npm test` — everything must pass.
4. If you touched the decision logic, make sure the interactive demo on
   `index.html` still agrees with the CLI.

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

Publishing requires an npm account token with 2FA bypass (npmjs.com →
Access Tokens → *Granular Access Token*, scoped to the package, with the
2FA-bypass option ticked) when the account has two-factor auth enabled.

1. Bump the version in `package.json` (semver) and move the matching
   `[Unreleased]` content in `CHANGELOG.md` into a dated release entry.
2. Run `npm publish --dry-run` first: the `files` field keeps the tarball to
   `bin/`, `src/`, and the README/LICENSE/CHANGELOG — verify the listing
   before anything goes out.
3. `npm publish` runs `prepublishOnly` (`npm test`) and refuses to proceed if
   any test fails.
4. Tag the release at the exact commit whose tree npm published (normally the
   bump commit just created) and push the tag explicitly:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z: <one-line summary>"   # tags HEAD
   git push origin vX.Y.Z
   ```

   If `main` has drifted past the published version, tag the bump commit
   itself rather than latest `main`, so the tag matches the npm artifact
   (`git rev-parse vX.Y.Z^{commit}` must equal the bump commit). The release
   tag is also what consumers pin for the GitHub Action, so a version whose
   tree lacks a feature must not be presented as carrying it.
5. Create a GitHub Release for the tag with notes from the matching
   CHANGELOG entry and a link to the npm package
   (https://www.npmjs.com/package/@maliqkara/gitcleanup).

### Tagging past releases

npm versions can outlive their tags: `v0.2.1` (the first npm-published
version) was tagged at `e275e99` only after later work had already landed on
`main`. To tag an older published version retroactively, find the commit
whose tree was published (its `package.json` shows that name + version) and
run `git tag -a vX.Y.Z <sha> && git push origin vX.Y.Z`, then create its
GitHub Release. Note that `v0.2.1`'s tree predates the GitHub Action, so
`@v0.2.1` pins a CLI-only snapshot — `v0.2.2` (which ships the action) is the
earliest tag that resolves `Asunachi/git-cleanup/.github/actions/scan-report`.
