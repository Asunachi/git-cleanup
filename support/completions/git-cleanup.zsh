#compdef git-cleanup
# zsh completion for git-cleanup.
# Install:  git-cleanup completions zsh > "${fpath[1]}/_git-cleanup"
# (then restart the shell, or run: autoload -U compinit && compinit)

_git_cleanup() {
  local -a commands options
  commands=(scan prune prs report-issue doctor backup completions shell-hook help)
  options=(-y --yes --force --remote --repo --config --json --summary --check -v --verbose --no-pr --close --title --dry-run -V --version -h --help)

  if (( CURRENT == 2 )); then
    compadd -a commands
    compadd -a options
  elif [[ ${words[2]} == completions && CURRENT == 3 ]]; then
    compadd bash zsh fish
  elif [[ ${words[2]} == shell-hook && CURRENT == 3 ]]; then
    compadd bash zsh fish pre-commit
  elif [[ ${words[2]} == backup && CURRENT == 3 ]]; then
    compadd list restore
  else
    compadd -a options
  fi
}

_git_cleanup "$@"