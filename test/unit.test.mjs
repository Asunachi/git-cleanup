import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daysBetween, globToRegExp, matchesAny } from "../src/util.mjs";
import { classify, classifyRemote, defaults, VERDICTS } from "../src/classify.mjs";
import { loadConfig, normalizeConfig } from "../src/config.mjs";

// ---- globs -----------------------------------------------------------------

test("globToRegExp basics", () => {
  assert.ok(globToRegExp("main").test("main"));
  assert.ok(!globToRegExp("main").test("main2"));
  assert.ok(globToRegExp("feature/*").test("feature/x"));
  assert.ok(!globToRegExp("feature/*").test("feature/x/y"));
  assert.ok(globToRegExp("feature/*").test("feature/x-y"));
  assert.ok(!globToRegExp("feature/*").test("other/x"));
});

test("globToRegExp double star spans slashes", () => {
  assert.ok(globToRegExp("release/**").test("release/v1"));
  assert.ok(globToRegExp("release/**").test("release/v1/hotfix"));
  assert.ok(!globToRegExp("release/**").test("release"));
  assert.ok(globToRegExp("**/feature").test("feature"));
  assert.ok(globToRegExp("**/feature").test("a/b/feature"));
  assert.ok(!globToRegExp("**/feature").test("featurex"));
  assert.ok(globToRegExp("a/**/b").test("a/b"));
  assert.ok(globToRegExp("a/**/b").test("a/x/y/b"));
});

test("globToRegExp escapes regex metacharacters", () => {
  assert.ok(globToRegExp("branch.one").test("branch.one"));
  assert.ok(!globToRegExp("branch.one").test("branchXone"));
});

test("matchesAny", () => {
  assert.ok(matchesAny(["a", "b/**"], "b/c"));
  assert.ok(!matchesAny(["a", "b/**"], "d"));
});

test("daysBetween", () => {
  assert.equal(daysBetween(1000 * 86400, 999 * 86400), 1);
  assert.equal(daysBetween(1000 * 86400, 1000 * 86400), 0);
  assert.equal(daysBetween(1000 * 86400, 1 * 86400), 999);
});

// ---- classification ---------------------------------------------------------

function ctx(over = {}) {
  return {
    isHead: false,
    baseNames: new Set(["origin/main"]),
    baseShort: new Set(["main"]),
    ...over,
  };
}

function branch(over) {
  return {
    name: "feature/x",
    shortName: "feature/x",
    type: "local",
    ageDays: 0,
    merged: false,
    orphan: false,
    pr: null,
    ...over,
  };
}

test("merged branches past threshold are prunable", () => {
  const cfg = defaults();
  const d = classify(branch({ merged: true, ageDays: 30 }), cfg, ctx());
  assert.equal(d.verdict, VERDICTS.DELETE);
  assert.equal(d.reason, "merged");
});

test("recently merged branches are kept", () => {
  const d = classify(branch({ merged: true, ageDays: 3 }), defaults(), ctx());
  assert.equal(d.verdict, VERDICTS.KEEP);
  assert.equal(d.reason, "too-young");
});

test("unmerged stale branches warn but never auto-delete", () => {
  const d = classify(branch({ ageDays: 100 }), defaults(), ctx());
  assert.equal(d.verdict, VERDICTS.WARN);
  const fresh = classify(branch({ ageDays: 2 }), defaults(), ctx());
  assert.equal(fresh.verdict, VERDICTS.KEEP);
  assert.equal(fresh.reason, "active");
});

test("open PRs keep branches alive (until truly stale)", () => {
  const cfg = defaults();
  const d = classify(
    branch({ pr: { state: "open", ageDays: 5 } }),
    cfg,
    ctx()
  );
  assert.equal(d.verdict, VERDICTS.KEEP);
  const stale = classify(
    branch({ pr: { state: "open", ageDays: 200 } }),
    cfg,
    ctx()
  );
  assert.equal(stale.verdict, VERDICTS.WARN);
  assert.equal(stale.reason, "stale-pr");
});

test("protected names never pruned", () => {
  const cfg = defaults();
  cfg.protected = ["snowflake"];
  const onHead = classify(
    branch({ name: "main", shortName: "main", merged: true, ageDays: 999 }),
    cfg,
    ctx({ isHead: true })
  );
  assert.equal(onHead.verdict, VERDICTS.KEEP);
  assert.equal(onHead.reason, "head");

  const prot = classify(
    branch({ name: "snowflake", shortName: "snowflake", merged: true, ageDays: 999 }),
    cfg,
    ctx()
  );
  assert.equal(prot.verdict, VERDICTS.KEEP);
  assert.equal(prot.reason, "protected");
});

test("force rules delete unmerged branches only when they match", () => {
  const cfg = defaults();
  cfg.rules = [{ match: "tmp/*", mode: "any", minAgeDays: 1 }];
  const d = classify(
    branch({ name: "tmp/scratch", shortName: "tmp/scratch", ageDays: 3 }),
    cfg,
    ctx()
  );
  assert.equal(d.verdict, VERDICTS.DELETE);
  assert.equal(d.reason, "rule-force");

  const young = classify(
    branch({ name: "tmp/scratch", shortName: "tmp/scratch", ageDays: 0 }),
    cfg,
    ctx()
  );
  assert.equal(young.verdict, VERDICTS.KEEP);

  const noMatch = classify(branch({ ageDays: 90 }), cfg, ctx());
  assert.equal(noMatch.verdict, VERDICTS.WARN);
});

test("merged-rule overrides generic threshold for matching names", () => {
  const cfg = defaults();
  cfg.deleteMergedAfterDays = 999;
  cfg.rules = [{ match: "feature/ci-*", mode: "merged", minAgeDays: 5 }];
  const d = classify(
    branch({ name: "feature/ci-1", shortName: "feature/ci-1", merged: true, ageDays: 8 }),
    cfg,
    ctx()
  );
  assert.equal(d.verdict, VERDICTS.DELETE);
  assert.equal(d.reason, "merged-rule");

  const unmerged = classify(
    branch({ name: "feature/ci-1", shortName: "feature/ci-1", merged: false, ageDays: 8 }),
    cfg,
    ctx()
  );
  assert.equal(unmerged.verdict, VERDICTS.KEEP);
  assert.equal(unmerged.reason, "unmerged-rule");
});

test("merged-mode rule can RAISE the generic threshold", () => {
  const cfg = defaults(); // deleteMergedAfterDays: 21
  cfg.rules = [{ match: "feature/ci-*", mode: "merged", minAgeDays: 60 }];
  // Merged 30 days: past the generic 21d threshold, but the rule demands 60d.
  const kept = classify(
    branch({ name: "feature/ci-1", shortName: "feature/ci-1", merged: true, ageDays: 30 }),
    cfg,
    ctx()
  );
  assert.equal(kept.verdict, VERDICTS.KEEP);
  assert.equal(kept.reason, "rule-young");

  const deleted = classify(
    branch({ name: "feature/ci-1", shortName: "feature/ci-1", merged: true, ageDays: 70 }),
    cfg,
    ctx()
  );
  assert.equal(deleted.verdict, VERDICTS.DELETE);
  assert.equal(deleted.reason, "merged-rule");

  // Unrelated branches still follow the generic 21d threshold.
  const other = classify(
    branch({ name: "feature/x", shortName: "feature/x", merged: true, ageDays: 30 }),
    cfg,
    ctx()
  );
  assert.equal(other.verdict, VERDICTS.DELETE);
  assert.equal(other.reason, "merged");
});

test("remote cleanup gate: merged past threshold only when enabled", () => {
  const cfg = defaults();
  const remote = { ...branch({ type: "remote", name: "origin/x", shortName: "x", ageDays: 30, merged: true }), remoteName: "origin" };
  assert.equal(classifyRemote(remote, cfg)?.verdict, VERDICTS.DELETE);

  cfg.remote.pruneMerged = false;
  assert.equal(classifyRemote(remote, cfg), null);

  cfg.remote.pruneMerged = true;
  const young = { ...remote, ageDays: 2 };
  assert.equal(classifyRemote(young, cfg), null);
});

test("remote cleanup gate: abandoned PRs", () => {
  const cfg = defaults();
  cfg.remote.deleteAbandonedAfterDays = 60;
  const abandoned = {
    ...branch({ type: "remote", name: "origin/a", shortName: "a", ageDays: 100, merged: false }),
    pr: { state: "closed", ageDays: 90 },
  };
  assert.equal(classifyRemote(abandoned, cfg)?.reason, "abandoned-pr");

  const tooFresh = {
    ...abandoned,
    pr: { state: "closed", ageDays: 5 },
  };
  assert.equal(classifyRemote(tooFresh, cfg), null);

  const stillOpen = { ...abandoned, pr: { state: "open", ageDays: 90 } };
  assert.equal(classifyRemote(stillOpen, cfg), null);

  const mergedPr = { ...abandoned, pr: { state: "merged", ageDays: 90 } };
  assert.equal(classifyRemote(mergedPr, cfg), null);
});

// ---- config ----------------------------------------------------------------

test("normalizeConfig clamps and validates", () => {
  // normalize only carries what the config layer actually set; defaults are
  // applied later during loadConfig merging.
  assert.deepEqual(normalizeConfig({}), {});
  assert.equal(normalizeConfig({ deleteMergedAfterDays: 5 }).deleteMergedAfterDays, 5);
  assert.equal(normalizeConfig({ deleteMergedAfterDays: "14" }).deleteMergedAfterDays, 14);
  assert.throws(() => normalizeConfig({ deleteMergedAfterDays: "abc" }));
  assert.throws(() => normalizeConfig({ deleteMergedAfterDays: -3 }));
  assert.throws(() => normalizeConfig({ pr: { staleAfterDays: "nope" } }));
  assert.throws(() => normalizeConfig({ rules: [{ mode: "sometimes" }] }));
  assert.equal(normalizeConfig({ remote: { pruneMerged: false } }).remote.pruneMerged, false);
  assert.equal(
    normalizeConfig({ deleteMergedAfterDays: 5, remote: { pruneMerged: true } }).deleteMergedAfterDays,
    5
  );
});

test("config layers: defaults < cwd config < --config", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-cfg-"));
  try {
    writeFileSync(join(dir, ".gitcleanup.json"), JSON.stringify({ deleteMergedAfterDays: 77 }));

    const l1 = loadConfig({ cwd: dir, homeFile: join(dir, "no-home.json") });
    assert.equal(l1.cfg.deleteMergedAfterDays, 77);
    assert.equal(l1.repos.length, 1);
    assert.equal(l1.repos[0], dir);

    const explicit = join(dir, "explicit.json");
    writeFileSync(explicit, JSON.stringify({ deleteMergedAfterDays: 5, repos: ["sub"] }));
    const l2 = loadConfig({ cwd: dir, configFile: explicit, homeFile: join(dir, "no-home.json") });
    assert.equal(l2.cfg.deleteMergedAfterDays, 5);
    assert.equal(l2.repos[0], join(dir, "sub"));

    const l3 = loadConfig({ cwd: dir, repoFlags: ["elsewhere"], homeFile: join(dir, "no-home.json") });
    assert.equal(l3.repos[0], join(dir, "elsewhere"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repos resolve relative to the config layer that defines them", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-cfg-"));
  try {
    // Repo-level config defines repos; an explicit --config without a repos
    // list must not move the base directory to the explicit file's folder.
    writeFileSync(join(dir, ".gitcleanup.json"), JSON.stringify({ repos: ["sub"] }));
    const other = join(dir, "other");
    mkdirSync(other, { recursive: true });
    const explicit = join(other, "override.json");
    writeFileSync(explicit, JSON.stringify({ deleteMergedAfterDays: 3 }));
    const l = loadConfig({
      cwd: dir,
      configFile: explicit,
      homeFile: join(dir, "no-home.json"),
    });
    assert.equal(l.cfg.deleteMergedAfterDays, 3);
    assert.deepEqual(l.repos, [join(dir, "sub")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("home config merges under cwd config", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-cfg-"));
  try {
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const home = join(homeDir, "config.json");
    writeFileSync(home, JSON.stringify({ deleteMergedAfterDays: 11, warnUnmergedAfterDays: 3 }));
    writeFileSync(join(dir, ".gitcleanup.json"), JSON.stringify({ warnUnmergedAfterDays: 9 }));
    const l = loadConfig({ cwd: dir, homeFile: home });
    assert.equal(l.cfg.deleteMergedAfterDays, 11); // home won
    assert.equal(l.cfg.warnUnmergedAfterDays, 9); // cwd won
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
