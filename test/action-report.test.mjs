import { test } from "node:test";
import assert from "node:assert/strict";

import { prLabel, render } from "../.github/actions/scan-report/report.mjs";

const BRANCH = (over = {}) => ({
  name: "feature/x",
  type: "local",
  ageDays: 40,
  merged: false,
  verdict: "keep",
  reason: "active",
  ...over,
});

const REPO = (branches, over = {}) => ({
  path: "/work/repo",
  baseRefs: ["origin/main"],
  headBranch: "main",
  branches,
  ...over,
});

test("prLabel formats PR states", () => {
  assert.equal(prLabel(undefined), "-");
  assert.equal(prLabel({ number: 12, state: "merged" }), "merged #12");
  assert.equal(prLabel({ number: 3, state: "open", isDraft: true }), "draft #3");
  assert.equal(prLabel({ number: 7, state: "closed" }), "closed #7");
});

test("render lists prunable and stale with CLI reason labels", () => {
  const branches = [
    BRANCH({
      name: "feature/merged-old",
      ageDays: 60,
      merged: true,
      verdict: "delete",
      reason: "merged",
      pr: { number: 12, state: "merged" },
    }),
    BRANCH({
      name: "feature/squash",
      ageDays: 40,
      contentMerged: true,
      verdict: "delete",
      reason: "squash-merged",
    }),
    BRANCH({
      name: "origin/feature/old",
      type: "remote",
      ageDays: 50,
      merged: true,
      verdict: "delete",
      reason: "merged",
    }),
    BRANCH({ name: "wip/abandoned", ageDays: 100, verdict: "warn", reason: "stale-unmerged" }),
    BRANCH({ name: "main", reason: "protected", verdict: "keep" }),
    BRANCH({
      name: "feature/ci-x",
      ageDays: 30,
      merged: true,
      verdict: "delete",
      reason: "merged-rule",
      rule: "feature/ci-*",
    }),
  ];
  const { markdown, counts } = render({
    generatedAt: new Date().toISOString(),
    config: { deleteMergedAfterDays: 21, warnUnmergedAfterDays: 45 },
    repos: [REPO(branches)],
  });

  assert.equal(counts.prunable, 4);
  assert.equal(counts.stale, 1);
  assert.equal(counts.kept, 1);

  assert.match(markdown, /Prunable \(4\)/);
  assert.match(markdown, /`feature\/merged-old`/);
  assert.match(markdown, /merged into base/); // reasonLabel from src/report.mjs
  assert.match(markdown, /content merged into base \(squash\/rebase\)/);
  assert.match(markdown, /`wip\/abandoned`/);
  assert.match(markdown, /Stale — needs a human decision \(1\)/);
  assert.match(markdown, /rule "feature\/ci-\*" matched/); // reason + rule survive JSON
  // Remote branch present -> prune hint mentions --remote
  assert.match(markdown, /git-cleanup prune --remote/);
  // Kept branches are summarized as a count, not listed
  assert.doesNotMatch(markdown, /`main` \|/);
});

test("render caps long tables", () => {
  const del = Array.from({ length: 60 }, (_, i) =>
    BRANCH({ name: `feature/f${i}`, ageDays: 30, merged: true, verdict: "delete", reason: "merged" })
  );
  const { markdown } = render({ config: {}, repos: [REPO(del)] });
  assert.match(markdown, /_… and 10 more_/);
});

test("render all-clear repo", () => {
  const { markdown, counts } = render({
    config: {},
    repos: [REPO([BRANCH({ name: "main", reason: "protected", verdict: "keep" })])],
  });
  assert.equal(counts.prunable, 0);
  assert.equal(counts.stale, 0);
  assert.match(markdown, /✅ No prunable or stale branches\./);
});

test("render surfaces scan errors per repo", () => {
  const { markdown, counts } = render({
    config: {},
    repos: [
      REPO([], { path: "/work/repo", notGit: true, error: "\"/work/repo\" is not inside a git repository" }),
    ],
  });
  assert.equal(counts.errors, 1);
  assert.equal(counts.prunable, 0);
  assert.match(markdown, /⚠️ \/work\/repo/);
  assert.match(markdown, /not inside a git repository/);
});
