#!/usr/bin/env bash
# Update Formula/git-cleanup.rb to a release of the upstream git-cleanup
# project. This is the engine behind two callers:
#
#   * .github/workflows/update-formula.yml (scheduled + workflow_dispatch)
#     — bumps the formula directly on main;
#   * the git-cleanup release workflow (Asunachi/git-cleanup
#     .github/workflows/release.yml) — bumps the formula on a branch and
#     files a pull request (RELEASE_PR=1), so releases are reviewable
#     before the tap updates.
#
# It is deliberately runnable by hand from this repository's root with
# DRY_RUN=1 to rehearse the bump without touching anything.
#
# What it does:
#   1. resolves the release to bump to — RELEASE_TAG when set, otherwise the
#      newest vX.Y.Z tag of UPSTREAM_REPO via `gh api` (tags are the source
#      of truth; GitHub Release objects are optional and not required);
#   2. in PR mode, switches to the release-<tag> branch FIRST — the worktree
#      is still clean, so re-runs continue the previous branch instead of
#      forking it, and the branch's own formula then decides the bump state;
#   3. skips when the formula already carries a newer version; when it
#      already carries the target version, re-verifies the pinned sha256
#      against the release tarball and re-pins it if it drifted (a release
#      published from a different tree must never keep a stale checksum);
#   4. downloads the release tarball and computes its sha256;
#   5. rewrites `url` and `sha256` in the formula (single-source of truth),
#      validated on a copy first so a failure never leaves a half-bumped
#      formula behind;
#   6. unless DRY_RUN=1, commits and pushes — directly to BRANCH by
#      default, or on release-<tag> with a pull request when RELEASE_PR=1.
#
# Environment (all optional):
#   UPSTREAM_REPO  owner/repo whose releases drive the formula
#                  (default: Asunachi/git-cleanup)
#   RELEASE_TAG    explicit tag to bump to, e.g. v0.4.0 (default: latest
#                  release, resolved with the GitHub CLI)
#   FORMULA        path to the formula (default: Formula/git-cleanup.rb)
#   TARBALL_URL    where the tarball is downloaded from (default: the npm
#                  registry artifact for the new version — used by tests to
#                  point at a local fixture, and by the release workflow to
#                  hash the release tree before it reaches the registry)
#   WRITE_URL      the url line the formula is patched to (default:
#                  TARBALL_URL — set this to the registry artifact when
#                  TARBALL_URL is a local/file source)
#   BRANCH         branch to push / PR base (default: main)
#   RELEASE_PR     1 = commit on release-<tag> and open a pull request
#                  (requires the GitHub CLI)
#   TAP_REPO       owner/repo of this tap for the PR (default: derived from
#                  remote.origin.url)
#   DRY_RUN        1 = print what would change, patch nothing, commit nothing
set -euo pipefail

cd "$(dirname "$0")"

UPSTREAM_REPO="${UPSTREAM_REPO:-Asunachi/git-cleanup}"
FORMULA="${FORMULA:-Formula/git-cleanup.rb}"
BRANCH="${BRANCH:-main}"
TARBALL_URL="${TARBALL_URL:-}"
WRITE_URL="${WRITE_URL:-$TARBALL_URL}"
tap_repo=""
branch=""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# --- 1. resolve the release tag -------------------------------------------
if [ -n "${RELEASE_TAG:-}" ]; then
  tag="$RELEASE_TAG"
else
  command -v gh >/dev/null 2>&1 || {
    echo "error: no RELEASE_TAG given and the GitHub CLI ('gh') is not installed" >&2
    exit 1
  }
  # Tags are the source of truth (Asunachi/git-cleanup releases by tag, not
  # by GitHub Release objects), so resolve the newest vX.Y.Z tag. Sorting the
  # fetched names with -V keeps this correct regardless of API ordering.
  errf="$tmpdir/gh.err"
  if ! tag="$(gh api "repos/${UPSTREAM_REPO}/tags?per_page=100" -q '.[].name' 2>"$errf" \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1)"; then
    cat "$errf" >&2
    exit 1
  fi
  if [ -z "$tag" ]; then
    echo "no vX.Y.Z tags yet for ${UPSTREAM_REPO} — nothing to bump"
    exit 0
  fi
fi

version="${tag#v}" # tags are vX.Y.Z; the npm package (and formula url) is X.Y.Z
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "error: release tag '$tag' does not look like vX.Y.Z" >&2
    exit 1
    ;;
esac

# --- 2. PR mode: continue on the release branch first ----------------------
# Switching happens while the worktree is still clean, so a re-run never
# fights its own previous patch (git refuses to switch with a dirty formula
# even when the content matches). The branch's own formula then decides the
# bump state below: a re-run sees the bump already in place and exits.
if [ "${RELEASE_PR:-0}" = "1" ]; then
  command -v gh >/dev/null 2>&1 || {
    echo "error: RELEASE_PR=1 requires the GitHub CLI ('gh') to open the pull request" >&2
    exit 1
  }
  tap_repo="${TAP_REPO:-$(git config --get remote.origin.url | sed -E 's#^.*[:/]([^/:]+/[^/:]+)(\.git)?$#\1#')}"
  [ -n "$tap_repo" ] || {
    echo "error: could not derive the tap repo slug from remote.origin.url — set TAP_REPO" >&2
    exit 1
  }
  branch="release-${tag}"
  # A leftover local branch wins (this clone was left on it), then the
  # remote one (fresh checkout after a closed-but-unmerged PR), then a
  # brand-new one.
  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null 2>&1; then
    git switch "$branch"
  elif git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    git switch -c "$branch" "origin/$branch"
  else
    git switch -c "$branch"
  fi
fi

# --- 3. compare against the formula's current version ----------------------
[ -f "$FORMULA" ] || {
  echo "error: formula not found at $FORMULA" >&2
  exit 1
}
current="$(
  sed -nE 's#^  url ".*gitcleanup-([0-9][0-9.]*)\.tgz".*#\1#p' "$FORMULA" | head -n1
)"
if [ -z "$current" ]; then
  echo "error: could not read the current version from $FORMULA (expected a url line like 'gitcleanup-<version>.tgz')" >&2
  exit 1
fi

if [ "$current" != "$version" ]; then
  # Refuse to step backwards: sort -V newest-first, and bail if the formula's
  # version sorts after the release (sort -V is unavailable on some platforms;
  # then the guard is skipped, which is fine — equality was already handled).
  newest="$(printf '%s\n%s\n' "$current" "$version" | sort -V 2>/dev/null | tail -n1)"
  if [ "$newest" = "$current" ]; then
    echo "formula is at $current, which is newer than release $version — leaving it alone"
    exit 0
  fi
fi

# --- 4. download the tarball and compute its sha256 ------------------------
if [ -z "$WRITE_URL" ]; then
  WRITE_URL="https://registry.npmjs.org/@maliqkara/gitcleanup/-/gitcleanup-${version}.tgz"
fi
if [ -z "$TARBALL_URL" ]; then
  TARBALL_URL="$WRITE_URL"
fi
echo "downloading $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$tmpdir/gitcleanup.tgz"
sha="$(shasum -a 256 "$tmpdir/gitcleanup.tgz" | awk '{print $1}')"

# --- 5. same-version sanity: the pinned sha must match the tarball ---------
if [ "$current" = "$version" ]; then
  pinned="$(
    sed -nE 's#^  sha256 "([0-9a-f]{64})"#\1#p' "$FORMULA" | head -n1
  )"
  if [ -n "$pinned" ] && [ "$pinned" = "$sha" ]; then
    echo "formula already at git-cleanup $version with the current sha — nothing to do"
    exit 0
  fi
  echo "formula version matches $version but sha256 is stale (${pinned:-none} -> ${sha:0:12}…) — re-pinning"
fi

# --- 6. rewrite url + sha256 (validated on a copy, swapped in only after) --
sed -E \
  -e "s|^  url \".*\"|  url \"${WRITE_URL}\"|" \
  -e "s|^  sha256 \"[0-9a-f]{64}\"|  sha256 \"${sha}\"|" \
  "$FORMULA" > "$tmpdir/formula.new"

# The patch must have hit exactly one url line and one sha256 line, and the
# url must now point at exactly the artifact that was hashed. Only then is
# the original formula replaced — a failed validation never leaves a
# half-bumped file behind.
[ "$(grep -cE '^  url "' "$tmpdir/formula.new")" = 1 ] || {
  echo "error: after patching, expected exactly one 'url' line in $FORMULA" >&2
  exit 1
}
[ "$(grep -cE '^  sha256 "' "$tmpdir/formula.new")" = 1 ] || {
  echo "error: after patching, expected exactly one 'sha256' line in $FORMULA" >&2
  exit 1
}
patched_url="$(sed -nE 's#^  url "([^"]+)"#\1#p' "$tmpdir/formula.new" | head -n1)"
if [ "$patched_url" != "$WRITE_URL" ]; then
  echo "error: patched url is '${patched_url}', expected '${WRITE_URL}'" >&2
  exit 1
fi
cp "$tmpdir/formula.new" "$FORMULA"

echo "git-cleanup $current -> $version (sha256 ${sha:0:12}…)"
# Cosmetic only — never let a diff hiccup abort the bump (the commit step
# below still requires a real git repo and fails loudly without one).
git diff --stat -- "$FORMULA" 2>/dev/null || true

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN — not committing."
  exit 0
fi

# --- 7. commit and push ----------------------------------------------------
git config user.name  >/dev/null 2>&1 || git config user.name "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add -- "$FORMULA"
if git diff --cached --exit-code --quiet; then
  echo "no formula changes to commit (${branch:-$BRANCH} already carries the bump)"
else
  git commit -m "git-cleanup ${version}" -m "Auto-bumped by the ${UPSTREAM_REPO} release ${tag}."
  if [ "${RELEASE_PR:-0}" = "1" ]; then
    git push -u origin HEAD
    echo "pushed ${branch}"
  else
    git push origin "HEAD:${BRANCH}"
    echo "pushed git-cleanup ${version} to ${BRANCH}"
  fi
fi

# --- 8. open (or confirm) the pull request ---------------------------------
if [ "${RELEASE_PR:-0}" = "1" ]; then
  if gh pr view --repo "$tap_repo" "$branch" >/dev/null 2>&1; then
    echo "PR for ${branch} already exists"
  else
    gh pr create --repo "$tap_repo" --base "${BRANCH}" --head "$branch" \
      --title "git-cleanup ${version}" \
      --body "Auto-bumped by the git-cleanup release workflow from the ${UPSTREAM_REPO} release ${tag}.

Merge this to publish git-cleanup ${version} on Homebrew. The tap's update-formula workflow keeps the formula current afterwards; this PR exists so each release is reviewable before the tap updates."
    echo "opened PR for ${branch}"
  fi
fi