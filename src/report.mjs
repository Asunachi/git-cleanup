// Rendering of scan results: aligned table for humans, JSON for machines.

import { c } from "./util.mjs";
import { VERDICTS } from "./classify.mjs";

export function reasonLabel(branch) {
  const r = branch.reason;
  if (r === "merged") return branch.type === "local" ? "merged into base" : "merged into base";
  if (r === "merged-rule") return `rule "${branch.rule}" matched`;
  if (r === "rule-force") return `force rule "${branch.rule}"`;
  if (r === "stale-unmerged")
    return branch.orphan
      ? "unmerged and stale (local only, upstream gone)"
      : "unmerged and stale";
  if (r === "stale-pr") return "PR open but stale";
  if (r === "remote-disabled") return "remote cleanup disabled (cfg)";
  if (r === "abandoned-pr") return "PR closed, never merged";
  if (r === "open-pr") return "PR open";
  if (r === "too-young") return "merged recently";
  if (r === "rule-young") return "merged but below rule minAgeDays";
  if (r === "active") return "active";
  if (r === "head") return "checked out";
  if (r === "protected") return "protected";
  return r ?? "";
}

function prShort(pr, verbose) {
  if (!pr) return "-";
  const state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : pr.isDraft ? "draft" : "open";
  const extra = verbose && pr.title ? ` "${pr.title.slice(0, 40)}"` : "";
  return `${state} #${pr.number}${extra}`;
}

const pad = (s, n) => String(s).padEnd(n);

export function countBranches(branches) {
  const out = { delete: 0, warn: 0, keep: 0 };
  for (const b of branches) {
    out[b.verdict === VERDICTS.DELETE ? "delete" : b.verdict === VERDICTS.WARN ? "warn" : "keep"]++;
  }
  out.remoteDelete = branches.filter(
    (b) => b.verdict === VERDICTS.DELETE && b.type === "remote"
  ).length;
  return out;
}

export function actionableDelete(branches) {
  return branches.filter((b) => b.verdict === VERDICTS.DELETE);
}

/** Print a human-readable report for one analyzed repo to `out`. */
export function printRepoReport(repo, cfg, opts = {}) {
  const out = [];
  const verbose = Boolean(opts.verbose);
  const rows = repo.branches.filter(
    (b) => b.verdict !== VERDICTS.KEEP || verbose
  );
  if (verbose) {
    rows.sort((a, b) => b.ageDays - a.ageDays);
  } else {
    rows.sort((a, b) =>
      (a.verdict === b.verdict ? b.ageDays - a.ageDays : a.verdict < b.verdict ? -1 : 1)
    );
  }

  out.push("");
  out.push(c.bold(`📦 ${repo.path}${repo.root && repo.path !== repo.root ? `  (${repo.root})` : ""}`));
  const metaBits = [`base: ${repo.baseRefs.join(", ") || "(none)"}`];
  if (repo.meta.headBranch) metaBits.push(`HEAD: ${repo.meta.headBranch}`);
  out.push(c.dim(metaBits.join("   ")));

  if (repo.pr.source === "none" && repo.pr.repo && repo.pr.error) {
    out.push(c.dim(`PR tracking off: ${repo.pr.error}`));
  } else if (repo.pr.source !== "none") {
    out.push(
      c.dim(
        `PRs via ${repo.pr.source}: ${repo.pr.repo.owner}/${repo.pr.repo.repo}`
      )
    );
  }

  if (rows.length === 0) {
    out.push(c.green("  nothing to clean up 🎉"));
    const counts = countBranches(repo.branches);
    out.push(c.dim(`  ${counts.keep} branches kept (protected/active/young)`));
    return out.join("\n");
  }

  const nameW = Math.max(...rows.map((b) => b.name.length), 8) + 2;
  const typeW = 8;
  const ageW = 6;

  const head = `  ${pad("STATUS", 8)}${pad("BRANCH", nameW)}${pad("TYPE", typeW)}${pad("AGE", ageW)}${pad("MERGED", 7)}${pad("PR", 16)}REASON`;
  out.push(c.dim(head));
  for (const b of rows) {
    // Pad the plain text first, then color: ANSI escapes have zero display
    // width, so coloring before padding would misalign columns on a TTY.
    const statusText =
      b.verdict === VERDICTS.DELETE ? "PRUNE" : b.verdict === VERDICTS.WARN ? "stale" : "keep ";
    const status = pad(statusText, 8);
    const cellStatus =
      b.verdict === VERDICTS.DELETE
        ? c.red(status)
        : b.verdict === VERDICTS.WARN
          ? c.yellow(status)
          : c.green(status);
    const cellName = pad(b.name, nameW);
    const name =
      b.verdict === VERDICTS.DELETE
        ? c.red(cellName)
        : b.verdict === VERDICTS.WARN
          ? c.yellow(cellName)
          : cellName;
    out.push(
      `  ${cellStatus}${name}${pad(b.type, typeW)}${pad(`${b.ageDays}d`, ageW)}${pad(b.merged ? "yes" : "-", 7)}${pad(prShort(b.pr, verbose), 16)}${c.dim(reasonLabel(b))}`
    );
  }

  const counts = countBranches(repo.branches);
  const bits = [
    c.red(`${counts.delete} prunable`),
    c.yellow(`${counts.warn} stale`),
    c.dim(`${counts.keep} kept`),
  ];
  out.push("");
  out.push(`  ${bits.join(" · ")}`);
  if (counts.delete > 0) {
    const local = counts.delete - counts.remoteDelete;
    const hints = [];
    if (local > 0) hints.push("git-cleanup prune");
    if (counts.remoteDelete > 0) hints.push("git-cleanup prune --remote");
    out.push(c.dim(`  → ${hints.join("  /  ")} to delete them`));
  }
  return out.join("\n");
}

/** JSON payload for all repos (machine-readable). */
export function reposToJSON(repos, cfg) {
  return {
    tool: "git-cleanup",
    generatedAt: new Date().toISOString(),
    config: {
      deleteMergedAfterDays: cfg.deleteMergedAfterDays,
      warnUnmergedAfterDays: cfg.warnUnmergedAfterDays,
      prTrack: cfg.pr.track,
      remotePruneMerged: cfg.remote.pruneMerged,
      remoteDeleteAbandonedAfterDays: cfg.remote.deleteAbandonedAfterDays,
    },
    repos: repos.map((r) => ({
      path: r.path,
      notGit: r.notGit || undefined,
      error: r.error || undefined,
      baseRefs: r.baseRefs ?? undefined,
      headBranch: r.meta?.headBranch ?? undefined,
      remotes: r.meta?.remotes ?? undefined,
      pr: r.pr
        ? {
            source: r.pr.source,
            repo: r.pr.repo,
            error: r.pr.error || undefined,
          }
        : undefined,
      branches: (r.branches ?? []).map((b) => ({
        name: b.name,
        type: b.type,
        ageDays: b.ageDays,
        lastCommitUnix: b.commitUnix,
        merged: b.merged,
        orphan: b.orphan || undefined,
        upstream: b.upstream || undefined,
        pr: b.pr
          ? {
              number: b.pr.number,
              state: b.pr.state,
              isDraft: b.pr.isDraft,
              ageDays: b.pr.ageDays,
              title: b.pr.title,
              url: b.pr.url,
            }
          : undefined,
        verdict: b.verdict,
        reason: b.reason,
      })),
    })),
  };
}
