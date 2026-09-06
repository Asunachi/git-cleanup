// Structural tests for .github/workflows/release.yml — the one-button
// release pipeline (test → bump/tag/push/Release → tap PR). Pinned the same
// way ci-parity.test.mjs pins the CI definitions: if the workflow's trigger
// surface, permissions, or job wiring changes shape, this fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");

test("release workflow: dispatch-only, inputs, permissions, and job chain", () => {
  // Releases are deliberate: manual dispatch only, never push/PR/schedule.
  assert.match(WF, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(WF, /^\s+push:\s*$/m);
  assert.doesNotMatch(WF, /^\s+pull_request:\s*$/m);
  assert.doesNotMatch(WF, /schedule:/);

  // Inputs: semver segment (with a default), exact override, dry-run rehearsal.
  assert.match(WF, /version_bump:/);
  assert.match(WF, /options: \[patch, minor, major\]/);
  assert.match(WF, /default: patch/);
  assert.match(WF, /exact_version:/);
  assert.match(WF, /dry_run:/);
  assert.match(WF, /type: boolean/);

  // The automatic token is enough for the main repo; the tap repo needs the
  // TAP_REPO_TOKEN secret (cross-repo writes).
  assert.match(WF, /permissions:/);
  assert.match(WF, /contents: write/);

  // Serialize releases; never interleave two runs.
  assert.match(WF, /concurrency:/);
  assert.match(WF, /group: release/);

  // Job chain: test -> release -> tap-pr, with the version flowing through.
  assert.match(WF, /jobs:/);
  assert.match(WF, /needs: test/);
  assert.match(WF, /needs: release/);
  assert.match(WF, /outputs:/);
  assert.match(WF, /version: \${{ steps\.bump\.outputs\.version }}/);

  // The bump engine, run with full history (tag-reuse guard needs the refs).
  assert.match(WF, /fetch-depth: 0/);
  assert.match(WF, /support\/release\/bump-version\.mjs/);
  assert.match(WF, /exact=\${{ inputs\.exact_version }}/);
  assert.match(WF, /\$GITHUB_OUTPUT/);

  // Commit/tag/push scope: package.json + the tap formula scaffold only.
  assert.match(WF, /git add package\.json homebrew-git-cleanup\/Formula\/git-cleanup\.rb/);
  assert.match(WF, /git tag -a "v\$\{VERSION\}"/);
  assert.match(WF, /git push origin main "v\$\{VERSION\}"/);

  // A real release also publishes the GitHub Release object — the Releases
  // tab is what users and reviewers see — and rehearsals change nothing.
  assert.match(WF, /gh release create/);
  assert.match(WF, /--generate-notes/);
  // Boolean gates must use the boolean form — API-dispatched boolean inputs
  // coerce unpredictably in `!= 'true'` string comparisons (caught live on a
  // dry-run dispatch: the commit step ran anyway).
  assert.ok(
    (WF.match(/if: \$\{\{ !inputs\.dry_run \}\}/g) ?? []).length >= 3,
    "dry_run must gate both release steps and the tap-pr job"
  );
  assert.doesNotMatch(WF, /dry_run != 'true'/, "no string-comparison gates");

  // The tap PR: cross-repo checkout with the secret, formula bumped by the
  // tap's own updater in PR mode against the release tree (hashed locally —
  // the npm artifact does not exist on the registry until `npm publish`).
  assert.match(WF, /repository: Asunachi\/homebrew-git-cleanup/);
  assert.match(WF, /token: \${{ secrets\.TAP_REPO_TOKEN }}/);
  assert.match(WF, /GH_TOKEN: \${{ secrets\.TAP_REPO_TOKEN }}/);
  assert.match(WF, /RELEASE_TAG: v\${{ needs\.release\.outputs\.version }}/);
  assert.match(WF, /RELEASE_PR: "1"/);
  assert.match(WF, /WRITE_URL: https:\/\/registry\.npmjs\.org\/@maliqkara\/gitcleanup\//);
  assert.match(WF, /npm pack --pack-destination/);
  assert.match(WF, /TARBALL_URL="file:\/\/\$\{TGZ\}"/);
  assert.match(WF, /\.\/update-formula\.sh/);
});

test("release workflow: YAML sanity (no tabs, even indentation)", () => {
  for (const [i, raw] of WF.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() !== "" && !line.trim().startsWith("#")) {
      assert.ok(!line.includes("\t"), `line ${i + 1}: tabs are not YAML-safe here`);
      const indent = line.match(/^ */)[0].length;
      assert.equal(indent % 2, 0, `line ${i + 1}: odd indentation`);
    }
  }
});
