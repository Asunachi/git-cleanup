# bash completion for git-cleanup
# Install:  git-cleanup completions bash > ~/.local/share/bash-completion/completions/git-cleanup
# (or source this file from ~/.bashrc)

_git_cleanup() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  local commands="scan prune prs report-issue doctor backup completions shell-hook help"
  local options="-y --yes --force --remote --repo --config --json --summary --check -v --verbose --no-pr --close --title --dry-run -V --version -h --help"

  case "$prev" in
    --repo|--config)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return
      ;;
    shell-hook)
      COMPREPLY=( $(compgen -W "bash zsh fish pre-commit" -- "$cur") )
      return
      ;;
    backup)
      COMPREPLY=( $(compgen -W "list restore" -- "$cur") )
      return
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$options" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  fi
}

complete -F _git_cleanup git-cleanup