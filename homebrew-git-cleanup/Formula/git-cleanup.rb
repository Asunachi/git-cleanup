# Homebrew formula for git-cleanup, in its dedicated tap repository
# (Asunachi/homebrew-git-cleanup; `brew tap Asunachi/git-cleanup`).
#
# This file is AUTO-UPDATED by .github/workflows/update-formula.yml in this
# repository: on a schedule (and on demand via workflow_dispatch) it reads the
# latest release tag of Asunachi/git-cleanup, downloads the exact npm tarball
# that release publishes, and rewrites `url` and `sha256` below. Do not hand-
# edit version or sha256 — the next run will overwrite them.
#
# Manual bump, if you ever need one without the workflow:
#   npm pack @maliqkara/gitcleanup@<new-version> --pack-destination /tmp
#   shasum -a 256 /tmp/maliqkara-gitcleanup-<new-version>.tgz
# Then verify with `brew install --build-from-source ./Formula/git-cleanup.rb`.

class GitCleanup < Formula
  desc "Prune stale/merged Git branches, cross-referenced with PR status"
  homepage "https://github.com/Asunachi/git-cleanup"
  url "https://registry.npmjs.org/@maliqkara/gitcleanup/-/gitcleanup-0.4.0.tgz"
  sha256 "e6c3534e68e3a1084713349986f0cff0bdd41196906dd6a08cfb5f669f756e87"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/git-cleanup --version")
    assert_match "scan", shell_output("#{bin}/git-cleanup --help")
  end
end
