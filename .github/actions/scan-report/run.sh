#!/usr/bin/env bash
# Composite-action glue for the git-cleanup scan report.
# Expects env: INPUT_PATH, INPUT_UNSHALLOW, INPUT_REPORT, INPUT_ISSUE_TITLE,
# INPUT_TOKEN, GITHUB_ACTION_DIR (all set by action.yml). Runs standalone
# (outside Actions) too: GITHUB_* vars are optional there.
set -euo pipefail

REPO_DIR="${INPUT_PATH:-.}"
ACTION_DIR="${GITHUB_ACTION_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TOOL="$ACTION_DIR/../../../bin/git-cleanup.mjs"
RENDERER="$ACTION_DIR/report.mjs"

# --- 1. Validate and locate the scanned repository -------------------------
cd "$REPO_DIR"
REPO_ABS="$(pwd)"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "::error::'$REPO_ABS' is not inside a git repository (did the workflow check it out?)"
  exit 1
fi

# --- 2. Shallow-checkout handling ------------------------------------------
# CI checkouts default to fetch-depth: 1, which hides history from merge
# detection (both ancestor and squash/rebase). Fetch full history so the scan
# sees the same truth as a local clone.
WARNING=""
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  if [ "${INPUT_UNSHALLOW:-true}" = "true" ] && git remote get-url origin >/dev/null 2>&1; then
    echo "::group::Fetching full history (checkout was shallow)"
    # Explicit refspec: some checkouts (single-branch clones) track only the
    # checked-out branch; the scan needs every remote branch, like a local clone.
    if ! git fetch --unshallow --prune origin "+refs/heads/*:refs/remotes/origin/*"; then
      WARNING="The checkout was shallow and could not be unshallowed (network/auth?); merge detection may be incomplete."
      echo "::warning::$WARNING"
    fi
    echo "::endgroup::"
  else
    WARNING="Shallow checkout: merge detection is limited (use unshallow: 'true', or check out with fetch-depth: 0)."
    echo "::warning::$WARNING"
  fi
fi

# --- 3. Run the scan ---------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SCAN_JSON="$TMP/scan.json"
REPORT_MD="$TMP/report.md"
if ! GIT_CLEANUP_NO_COLOR=1 node "$TOOL" scan --json --repo "$REPO_ABS" >"$SCAN_JSON"; then
  echo "::error::git-cleanup scan failed (exit $?)"
  exit 1
fi

# --- 4. Render ---------------------------------------------------------------
if ! node "$RENDERER" "$SCAN_JSON" "$REPORT_MD"; then
  echo "::error::report rendering failed"
  exit 1
fi
if [ -n "${WARNING:-}" ]; then
  printf '\n> ⚠️ %s\n' "$WARNING" >>"$REPORT_MD"
fi

# totals written by the renderer as key=value lines
declare -A COUNTS
while IFS='=' read -r k v; do [ -n "$k" ] && COUNTS["$k"]="$v"; done <"$REPORT_MD.counts"
echo "::group::Scan report"
cat "$REPORT_MD"
echo "::endgroup::"

# --- 5. Expose outputs + step summary -----------------------------------------
for k in prunable stale kept repos errors; do
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$k" "${COUNTS[$k]:-0}" >>"$GITHUB_OUTPUT"
  fi
done
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$REPORT_MD" >>"$GITHUB_STEP_SUMMARY"
fi

# --- 6. Post the report to an issue (unattended channel) ----------------------
if [ "${INPUT_REPORT:-issue}" = "issue" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  TOKEN="${INPUT_TOKEN:-${GH_TOKEN:-}}"
  if [ -z "$TOKEN" ] || ! command -v gh >/dev/null 2>&1; then
    echo "::warning::report: 'issue' requested but no token/gh available; report only in the log and step summary"
  else
    export GH_TOKEN="$TOKEN"
    TITLE="${INPUT_ISSUE_TITLE:-git-cleanup: branch report}"
    # Reuse one open issue with this exact title instead of commenting per run.
    EXISTING="$(
      gh issue list --repo "$GITHUB_REPOSITORY" --state open --limit 100 \
        --json number,title 2>/dev/null |
        TITLE="$TITLE" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=process.env.TITLE;const hit=JSON.parse(d).find(i=>i.title===t);if(hit)console.log(hit.number)})'
    )"
    if [ -n "$EXISTING" ]; then
      gh issue edit "$EXISTING" --repo "$GITHUB_REPOSITORY" --body-file "$REPORT_MD"
      ISSUE_NUM="$EXISTING"
      echo "::notice::Updated report issue #$ISSUE_NUM"
    else
      ISSUE_NUM="$(gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" --body-file "$REPORT_MD")"
      ISSUE_NUM="${ISSUE_NUM##*/}"
      echo "::notice::Created report issue #$ISSUE_NUM"
    fi
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
      printf 'issue-number=%s\n' "$ISSUE_NUM" >>"$GITHUB_OUTPUT"
    fi
  fi
fi

# A repo that failed to scan is an error even though the report rendered.
if [ "${COUNTS[errors]:-0}" != "0" ]; then
  echo "::error::${COUNTS[errors]} repository(ies) could not be scanned"
  exit 1
fi
