# git-cleanup shell integration for fish.
#
# Install:
#   git-cleanup shell-hook fish > ~/.config/fish/conf.d/git-cleanup.fish
#   # or, from a checkout:
#   cp <path-to>/support/dotfiles/git-cleanup.fish ~/.config/fish/conf.d/git-cleanup.fish
#
# What it does: whenever the working directory changes into a git repository
# (including the directory the shell starts in), runs `git-cleanup scan
# --summary` — at most once per repository per interval. It only REPORTS;
# it never deletes anything.
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
#   - The stamp cache lives in $HOME/.cache/git-cleanup, one tiny file per
#     repository — nothing is written into .git.

function __git_cleanup_maybe_scan --on-variable PWD
    set -q GIT_CLEANUP_DISABLE; and return
    command -sq git-cleanup; or return
    git rev-parse --is-inside-work-tree >/dev/null 2>&1; or return
    set -l root (git rev-parse --show-toplevel 2>/dev/null); or return

    set -l interval 3600
    if set -q GIT_CLEANUP_SCAN_INTERVAL
        set interval $GIT_CLEANUP_SCAN_INTERVAL
    end

    set -l cache "$HOME/.cache/git-cleanup"
    set -l stamp "$cache/shell-"(printf '%s' $root | cksum | awk '{print $1}')
    if test -f "$stamp"
        set -l age (math (date +%s) - (cat "$stamp"))
        test $age -lt $interval; and return
    end

    mkdir -p "$cache" 2>/dev/null
    date +%s >"$stamp" 2>/dev/null

    if set -q GIT_CLEANUP_PR
        git-cleanup scan --summary $GIT_CLEANUP_ARGS
    else
        git-cleanup scan --summary --no-pr $GIT_CLEANUP_ARGS
    end
end