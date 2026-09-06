#!/usr/bin/env bash
# Update Formula/git-cleanup.rb to the latest release of the upstream
# git-cleanup project. This is the engine behind
# .github/workflows/update-formula.yml (scheduled + workflow_dispatch), and
# it is deliberately runnable by hand from this repository's root with
# DRY_RUN=1 to rehearse the bump without touching anything.
#
# What it does:
#   1. resolves the release to bump to — RELEASE_TAG when set, otherwise the
#      newest vX.Y.Z tag of UPSTREAM_REPO via `gh api` (tags are the source
#      of truth; GitHub Release objects are optional and not required);
#   2. skips when the formula already carries that version (or a newer one);
#   3. downloads the exact npm tarball that release publishes and computes
#      its sha256;
#   4. rewrites `url` and `sha256` in the formula (single-source of truth);
#   5. unless DRY_RUN=1, commits the bump and pushes it to BRANCH.
#
# Environment (all optional):
#   UPSTREAM_REPO  owner/repo whose releases drive the formula
#                  (default: Asunachi/git-cleanup)
#   RELEASE_TAG    explicit tag to bump to, e.g. v0.4.0 (default: latest
#                  release, resolved with the GitHub CLI)
#   FORMULA        path to the formula (default: Formula/git-cleanup.rb)
#   TARBALL_URL    override for where the tarball is downloaded from
#                  (default: the npm registry artifact for the new version —
#                  used by tests to point at a local fixture)
#   BRANCH         branch to push (default: main)
#   DRY_RUN        1 = print what would change, patch nothing, commit nothing
set -euo pipefail

cd "$(dirname "$0")"

UPSTREAM_REPO="${UPSTREAM_REPO:-Asunachi/git-cleanup}"
FORMULA="${FORMULA:-Formula/git-cleanup.rb}"
TARBALL_URL="${TARBALL_URL:-}"
BRANCH="${BRANCH:-main}"

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

# --- 2. compare against the formula's current version ----------------------
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

if [ "$current" = "$version" ]; then
  echo "formula already at git-cleanup $version — nothing to do"
  exit 0
fi
# Refuse to step backwards: sort -V newest-first, and bail if the formula's
# version sorts after the release (sort -V is unavailable on some platforms;
# then the guard is skipped, which is fine — equality was already handled).
newest="$(printf '%s\n%s\n' "$current" "$version" | sort -V 2>/dev/null | tail -n1)"
if [ "$newest" = "$current" ]; then
  echo "formula is at $current, which is newer than release $version — leaving it alone"
  exit 0
fi

# --- 3. download the tarball and compute its sha256 ------------------------
if [ -z "$TARBALL_URL" ]; then
  TARBALL_URL="https://registry.npmjs.org/@maliqkara/gitcleanup/-/gitcleanup-${version}.tgz"
fi
echo "downloading $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$tmpdir/gitcleanup.tgz"
sha="$(shasum -a 256 "$tmpdir/gitcleanup.tgz" | awk '{print $1}')"

# --- 4. rewrite url + sha256 (validated on a copy, swapped in only after) --
sed -E \
  -e "s|^  url \".*\"|  url \"${TARBALL_URL}\"|" \
  -e "s|^  sha256 \"[0-9a-f]{64}\"|  sha256 \"${sha}\"|" \
  "$FORMULA" > "$tmpdir/formula.new"

# The patch must have hit exactly one url line and one sha256 line, and the
# url must now point at exactly the tarball that was hashed. Only then is the
# original formula replaced — a failed validation never leaves a half-bumped
# file behind.
[ "$(grep -cE '^  url "' "$tmpdir/formula.new")" = 1 ] || {
  echo "error: after patching, expected exactly one 'url' line in $FORMULA" >&2
  exit 1
}
[ "$(grep -cE '^  sha256 "' "$tmpdir/formula.new")" = 1 ] || {
  echo "error: after patching, expected exactly one 'sha256' line in $FORMULA" >&2
  exit 1
}
patched_url="$(sed -nE 's#^  url "([^"]+)"#\1#p' "$tmpdir/formula.new" | head -n1)"
if [ "$patched_url" != "$TARBALL_URL" ]; then
  echo "error: patched url is '${patched_url}', expected '${TARBALL_URL}'" >&2
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

# --- 5. commit and push ----------------------------------------------------
git config user.name  >/dev/null 2>&1 || git config user.name "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add -- "$FORMULA"
git commit -m "git-cleanup ${version}" -m "Auto-bumped by the update-formula workflow from the ${UPSTREAM_REPO} release ${tag}."
git push origin "HEAD:${BRANCH}"
echo "pushed git-cleanup ${version} to ${BRANCH}"
