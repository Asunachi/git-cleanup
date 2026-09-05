# git-cleanup shell integration for bash and zsh.
#
# Install:
#   git-cleanup shell-hook bash >> ~/.bashrc    (zsh:  >> ~/.zshrc)
#   # or, from a checkout:
#   echo 'source <path-to>/support/dotfiles/git-cleanup.sh' >> ~/.bashrc
#
# What it does: after every `cd` into a git repository — and once for the
# directory your shell starts in — it runs `git-cleanup scan --summary`, but
# at most once per repository per interval. It only REPORTS; it never
# deletes anything.
#
# Knobs (environment variables):
#   GIT_CLEANUP_DISABLE=1          turn the automatic scan off entirely
#   GIT_CLEANUP_SCAN_INTERVAL=300  minimum seconds between scans per repo
#                                  (default 3600; 0 = scan on every cd)
#   GIT_CLEANUP_PR=1               include PR state (needs gh or a forge
#                                  token; adds network calls)
#   GIT_CLEANUP_ARGS="--verbose"   extra arguments for the scan
#
# Notes:
#   - The scan is synchronous and can take ~0.4-3s on large repositories;
#     the interval cache is what keeps prompts snappy.
#   - The stamp cache lives in ${XDG_CACHE_HOME:-$HOME/.cache}/git-cleanup,
#     one tiny file per repository — nothing is written into .git.

__git_cleanup_maybe_scan() {
  [ -n "${GIT_CLEANUP_DISABLE:-}" ] && return 0
  command -v git-cleanup >/dev/null 2>&1 || return 0
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  local root interval stamp age
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  interval="${GIT_CLEANUP_SCAN_INTERVAL:-3600}"
  stamp="${XDG_CACHE_HOME:-$HOME/.cache}/git-cleanup/shell-$(printf '%s' "$root" | cksum | awk '{print $1}')"
  if [ "$interval" -gt 0 ] 2>/dev/null && [ -f "$stamp" ]; then
    age=$(( $(date +%s) - $(cat "$stamp" 2>/dev/null || echo 0) ))
    [ "$age" -lt "$interval" ] && return 0
  fi
  mkdir -p "$(dirname "$stamp")" 2>/dev/null
  date +%s > "$stamp" 2>/dev/null
  if [ -n "${GIT_CLEANUP_PR:-}" ]; then
    git-cleanup scan --summary ${GIT_CLEANUP_ARGS:-}
  else
    git-cleanup scan --summary --no-pr ${GIT_CLEANUP_ARGS:-}
  fi
}

# zsh: run on every directory change (fires for the starting directory too).
# bash: PROMPT_COMMAND runs before every prompt; the PWD guard turns it into
# a cd hook without re-scanning on every prompt.
if [ -n "${ZSH_VERSION:-}" ]; then
  if ! printf '%s\n' "${chpwd_functions[@]:-}" | grep -q __git_cleanup_maybe_scan; then
    chpwd_functions+=(__git_cleanup_maybe_scan)
  fi
  __git_cleanup_maybe_scan
else
  __git_cleanup_prompt_cmd() {
    if [ "${PWD}" != "${__git_cleanup_last_pwd:-}" ]; then
      __git_cleanup_last_pwd="${PWD}"
      __git_cleanup_maybe_scan
    fi
  }
  case ";${PROMPT_COMMAND:-};" in
    *";__git_cleanup_prompt_cmd;"*) ;;
    *) PROMPT_COMMAND="__git_cleanup_prompt_cmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi