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

Bump the version in `package.json`, add an entry to `CHANGELOG.md`, tag the
release, and publish if applicable.
