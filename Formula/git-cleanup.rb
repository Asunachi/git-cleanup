# Homebrew formula for git-cleanup.
#
# This repository doubles as a Homebrew tap: `brew tap Asunachi/git-cleanup`
# then `brew install git-cleanup`. The formula installs the exact npm tarball
# that npm serves for the pinned version.
#
# On release (see CONTRIBUTING.md): bump `version` and replace `sha256` with
# the published tarball's digest:
#
#   npm pack @maliqkara/gitcleanup@<new-version> --pack-destination /tmp
#   shasum -a 256 /tmp/maliqkara-gitcleanup-<new-version>.tgz
#
# Then re-verify with `brew install --build-from-source ./Formula/git-cleanup.rb`.

class GitCleanup < Formula
  desc "Prune stale/merged Git branches, cross-referenced with PR status"
  homepage "https://github.com/Asunachi/git-cleanup"
  url "https://registry.npmjs.org/@maliqkara/gitcleanup/-/gitcleanup-0.3.0.tgz"
  sha256 "ad6923d8820ffd60381eaa846344cc917ccef7658a3a7d3692ba94f4af6efcfb"
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