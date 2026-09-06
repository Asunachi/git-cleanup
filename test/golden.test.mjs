// Golden-history merge-detection tests.
//
// Each fixture builds a REAL repository with a specific real-world history
// shape (rebase, cherry-pick, octopus, fast-forward, hundreds of branches)
// and the golden table below pins the analyzer's verdict for every branch —
// the expected outcome is data, not derived from the analyzer. The seeded
// merge fuzz finds *a* bug; these fixtures prove your user's actual history
// shapes are judged correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeCherryPickRepo,
  makeFfMergeRepo,
  makeManyBranchesRepo,
  makeOctopusRepo,
  makeRebaseRepo,
  makeSquashRepo,
} from "../support/helpers.mjs";
import { analyzeRepo } from "../src/analyze.mjs";
import { defaults, VERDICTS } from "../src/classify.mjs";

const fixtures = [];
function fixture(f) {
  fixtures.push(f);
  return f;
}
test.after(() => {
  for (const f of fixtures) f.cleanup();
});

function byName(repo, name) {
  const b = repo.branches.find((x) => x.name === name);
  assert.ok(b, `branch ${name} should exist`);
  return b;
}

/** Assert a golden verdict table; every listed branch must classify exactly so. */
function assertGolden(repo, table, { reasons = {} } = {}) {
  for (const [name, want] of Object.entries(table)) {
    const b = byName(repo, name);
    assert.equal(b.verdict, want, `${name}: verdict (reason: ${b.reason})`);
    if (reasons[name]) {
      assert.equal(b.reason, reasons[name], `${name}: reason`);
    }
  }
}

test("golden: squash merge (commits rewritten, same tree)", async () => {
  const repo = await analyzeRepo(fixture(makeSquashRepo()).work, defaults());
  assertGolden(repo, {
    "feature/squash": VERDICTS.DELETE,
    "feature/divergent": VERDICTS.WARN,
    "feature/noop": VERDICTS.WARN,
    main: VERDICTS.KEEP,
  });
  assert.equal(byName(repo, "feature/squash").reason, "squash-merged");
  // The net-empty branch's tree matches a base tree, but the content guard
  // (merge-base tree must differ) must NOT call it merged.
  assert.notEqual(byName(repo, "feature/noop").reason, "squash-merged");
});

test("golden: rebase merge (branch rewritten onto a moved base)", async () => {
  const repo = await analyzeRepo(fixture(makeRebaseRepo()).work, defaults());
  assertGolden(repo, {
    "feature/work": VERDICTS.DELETE,
    "feature/work-pre-rebase": VERDICTS.WARN,
    main: VERDICTS.KEEP,
  });
  assert.equal(byName(repo, "feature/work").reason, "merged");
  // The pre-rebase tip's tree (A+W) appears nowhere in main's history — the
  // rebase changed the base — so the conservative content guard must refuse
  // to call it merged: old unmerged work is flagged stale, never deleted.
  assert.equal(byName(repo, "feature/work-pre-rebase").reason, "stale-unmerged");
});

test("golden: cherry-pick merge (squash fingerprint via cherry-pick)", async () => {
  const repo = await analyzeRepo(fixture(makeCherryPickRepo()).work, defaults());
  assertGolden(repo, {
    "feature/cherry": VERDICTS.DELETE,
    main: VERDICTS.KEEP,
  });
  assert.equal(byName(repo, "feature/cherry").reason, "squash-merged");
});

test("golden: octopus merge (two heads, one merge commit)", async () => {
  const repo = await analyzeRepo(fixture(makeOctopusRepo()).work, defaults());
  assertGolden(repo, {
    "feature/o1": VERDICTS.DELETE,
    "feature/o2": VERDICTS.DELETE,
    main: VERDICTS.KEEP,
  });
  assert.equal(byName(repo, "feature/o1").reason, "merged");
  assert.equal(byName(repo, "feature/o2").reason, "merged");
});

test("golden: fast-forward merge (tip is the base tip)", async () => {
  const repo = await analyzeRepo(fixture(makeFfMergeRepo()).work, defaults());
  assertGolden(repo, {
    "feature/ff": VERDICTS.DELETE,
    main: VERDICTS.KEEP,
  });
  assert.equal(byName(repo, "feature/ff").reason, "merged");
});

test("golden: hundreds of branches classify exactly (200 merged + 30 stale)", async () => {
  const repo = await analyzeRepo(fixture(makeManyBranchesRepo(200, 30)).work, defaults());
  const byVerdict = { delete: 0, warn: 0, keep: 0 };
  for (const b of repo.branches) {
    byVerdict[b.verdict === VERDICTS.DELETE ? "delete" : b.verdict === VERDICTS.WARN ? "warn" : "keep"]++;
  }
  // main + 200 merged + 30 stale = 231 local branches, plus the pushed
  // origin/main remote ref = 232; exactly 200 prunable.
  assert.equal(repo.branches.length, 232, "no phantom branches at scale");
  assert.equal(byVerdict.delete, 200);
  assert.equal(byVerdict.warn, 30);
  assert.equal(byVerdict.keep, 2);
  assert.equal(byName(repo, "merged/branch-199").verdict, VERDICTS.DELETE);
  assert.equal(byName(repo, "merged/branch-199").reason, "merged");
  assert.equal(byName(repo, "stale/branch-29").verdict, VERDICTS.WARN);
});
