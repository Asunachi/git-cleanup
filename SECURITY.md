# Security Policy

## Supported versions

Only the latest published release receives security fixes. Fixes land on
`main` first and ship in the next release; when a fix is significant, the
release is expedited.

| Version | Supported          |
| ------- | ------------------ |
| latest  | ✅                 |
| older   | ❌ upgrade to the latest |

## Reporting a vulnerability

Please report security issues privately, not as public issues:

1. Use GitHub's **private vulnerability reporting** for this repository:
   <https://github.com/Asunachi/git-cleanup/security/advisories/new>
2. Include as much of the following as you can: the version affected, a
   minimal reproduction (repository layout + commands), the impact you
   observed, and any fix you already have in mind.
3. You will get an acknowledgement within a few days and a timeline for a
   fix once the report is triaged.

If the issue is an unauthenticated fork's duplicate or clearly not a
vulnerability, we'll say so and close it — but we'd rather look at a
false positive than miss a real one.

**Please do not file bug reports against the machine-generated
`git-cleanup: branch report` issue** on this repository; it is produced by
the project's own CI and is not a human. Open a fresh issue instead.

## Security-relevant behavior of this tool

git-cleanup deletes branches — that is its job — so its trust model is worth
stating explicitly:

- **Deletion is never automatic.** Nothing is removed without an explicit
  confirmation (or `--yes`), unmerged work is never deleted unless a
  user-authored force rule matches, and deletions that would lose unique
  commits are backed up into timestamped git bundles first
  (`backup.enabled`, default on).
- **The tool never touches `.git` internals.** All state is read and
  modified through the `git` binary only, so a bug cannot corrupt
  repository metadata directly.
- **Tokens are read from the environment only** (`GITHUB_TOKEN`,
  `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `GITEA_TOKEN`). They are never
  written to disk, logged, or sent anywhere except the forge's own API
  endpoint derived from your remote's hostname. `gh` uses its own
  credential store.
- **Config files are code.** A `.gitcleanup.json` (or `--config` file) can
  contain force rules that delete unmerged branches. Only apply config
  files you trust — treat a repo-level config from an untrusted checkout
  the same way you would treat its `.git/hooks` or a `package.json`
  `postinstall` script.
- **The GitHub Action is meant to run read-only on schedules.** It scans
  and reports; it never deletes branches.

## Supply chain

- The npm package is dependency-free (Node built-ins only), so the
  dependency supply chain is empty by construction. Still, pin the exact
  version you deploy: `@maliqkara/gitcleanup@0.3.0` (or the exact `v*` tag
  for the GitHub Action) rather than floating ranges.
- Releases are tested on Linux, macOS, and Windows from the packed tarball
  (`release-check` workflow) before they are announced.

## Security fixes

Fixes that affect the deletion path, token handling, or the action's
permissions are considered security-relevant and will be called out in the
CHANGELOG with a `Security` heading.