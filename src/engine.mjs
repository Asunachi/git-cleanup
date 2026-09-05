// The pure branch-decision engine — the single source of truth for what
// verdict a branch gets.
//
// Both consumers run this exact code:
//   - the CLI, via src/classify.mjs, which re-exports everything below (and
//     src/util.mjs, which re-exports the glob helpers), and
//   - the live playground page, via scripts/sync-playground.mjs, which
//     bundles this file into index.html between the __ENGINE__ markers.
//
// Keep this file dependency-free and side-effect-free: it is inlined into
// the browser as-is, so no imports, no Node APIs, no exports from other
// modules. test/playground-parity.test.mjs fails CI if the page's bundled
// copy drifts from this file.

// ---- glob matching (git-style: `*` / `**` / `?`) --------------------------

const ESCAPE_RE = /[.+^${}()|[\]\\]/g;

function escapeChar(ch) {
  return ch.replace(ESCAPE_RE, "\\$&");
}

/**
 * Convert a git-style glob into an anchored RegExp.
 * Supported wildcards:
 *   double star: matches anything, including "/" (multiple path segments)
 *   single star: matches any characters except "/"
 *   question:    matches a single character except "/"
 *
 * A double star directly followed by a slash (e.g. a leading globstar-slash
 * prefix) is optional, so that pattern also matches the bare name on its own.
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; ) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += escapeChar(ch);
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when `name` matches any glob in `patterns`. */
export function matchesAny(patterns, name) {
  return patterns.some((p) => globToRegExp(p).test(name));
}

// ---- verdicts + classification ---------------------------------------------

export const VERDICTS = {
  DELETE: "delete", // safe to prune
  WARN: "warn", // stale but needs a human decision
  KEEP: "keep", // active / protected / too young
};

const DEFAULT_PROTECTED = [
  "main",
  "master",
  "develop",
  "dev",
  "release",
  "release/**",
  "staging",
  "qa",
  "trunk",
  "HEAD",
];

/** Days a rule requires before it fires (defaults per mode). */
function ruleAge(rule, cfg) {
  if (Number.isFinite(rule.minAgeDays)) return rule.minAgeDays;
  return rule.mode === "any" ? 0 : cfg.deleteMergedAfterDays;
}

/**
 * classify a single branch.
 * branch: { name, type: "local"|"remote", shortName, ageDays, merged, orphan, pr }
 * ctx:    { isHead, baseNames:Set<string>, baseShort:Set<string> }
 *
 * Rules only ever apply to local branches; remote pruning has its own,
 * narrower gate (see classifyRemote).
 */
export function classify(branch, cfg, ctx) {
  const name = branch.shortName ?? branch.name;

  // 1. Never touch protected refs, the checked-out branch, or base branches.
  const protectedAll = [...DEFAULT_PROTECTED, ...(cfg.protected ?? [])];
  if (
    ctx.isHead ||
    ctx.baseNames.has(branch.name) ||
    ctx.baseShort.has(name) ||
    matchesAny(protectedAll, name)
  ) {
    return {
      verdict: VERDICTS.KEEP,
      reason: ctx.isHead ? "head" : "protected",
    };
  }

  const rule =
    branch.type === "local"
      ? (cfg.rules ?? []).find((r) => matchesAny([r.match], name))
      : undefined;

  // 2. Explicit force rule: delete regardless of merge state.
  if (rule && rule.mode === "any" && branch.ageDays >= ruleAge(rule, cfg)) {
    return { verdict: VERDICTS.DELETE, reason: "rule-force", rule: rule.match };
  }

  // 3. Integrated work: the safe, default cleanup path. Two flavors:
  //   merged        - tip is an ancestor of a base branch (regular merge)
  //   contentMerged - tip tree already exists in base history (squash/rebase)
  // A matching merged-mode rule fully owns the threshold for that branch (it
  // can raise OR lower the generic deleteMergedAfterDays), so do not fall
  // through to the generic one.
  const integrated = branch.merged || branch.contentMerged;
  if (integrated) {
    const ancestor = Boolean(branch.merged);
    if (rule && rule.mode === "merged") {
      if (branch.ageDays >= ruleAge(rule, cfg)) {
        return {
          verdict: VERDICTS.DELETE,
          reason: ancestor ? "merged-rule" : "squash-rule",
          rule: rule.match,
        };
      }
      return { verdict: VERDICTS.KEEP, reason: "rule-young" };
    }
    if (branch.ageDays >= cfg.deleteMergedAfterDays) {
      return {
        verdict: VERDICTS.DELETE,
        reason: ancestor ? "merged" : "squash-merged",
      };
    }
    return {
      verdict: VERDICTS.KEEP,
      reason: ancestor ? "too-young" : "content-young",
    };
  }

  // 4. Unmerged branches.
  if (branch.pr && branch.pr.state === "open") {
    // An open PR means the work is (probably) alive.
    if (branch.pr.ageDays < cfg.warnUnmergedAfterDays) {
      return { verdict: VERDICTS.KEEP, reason: "open-pr" };
    }
    return { verdict: VERDICTS.WARN, reason: "stale-pr" };
  }
  if (rule && rule.mode === "merged") {
    // A merged-only rule matched but the branch is not merged: keep it.
    return { verdict: VERDICTS.KEEP, reason: "unmerged-rule" };
  }
  if (branch.ageDays >= cfg.warnUnmergedAfterDays) {
    return { verdict: VERDICTS.WARN, reason: "stale-unmerged" };
  }
  return { verdict: VERDICTS.KEEP, reason: "active" };
}

/**
 * Gate for remote pruning (applies only when the user opted into touching
 * remote branches). Returns { verdict, reason } or null when the branch is
 * not eligible for remote cleanup under the current config.
 */
export function classifyRemote(branch, cfg) {
  if (branch.merged || branch.contentMerged) {
    if (!cfg.remote.pruneMerged) return null;
    if (branch.ageDays >= cfg.deleteMergedAfterDays) {
      return {
        verdict: VERDICTS.DELETE,
        reason: branch.merged ? "merged" : "squash-merged",
      };
    }
    return null;
  }
  // Abandoned PR: closed without merging, no activity for a while.
  if (
    cfg.remote.deleteAbandonedAfterDays > 0 &&
    branch.pr &&
    branch.pr.state === "closed" &&
    branch.pr.ageDays >= cfg.remote.deleteAbandonedAfterDays
  ) {
    return { verdict: VERDICTS.DELETE, reason: "abandoned-pr" };
  }
  return null;
}