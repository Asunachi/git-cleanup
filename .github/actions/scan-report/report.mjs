// Render scan --json output as a compact markdown report for issues / step
// summaries. Uses the CLI's own reasonLabel so labels never drift.
//
// Usage: node report.mjs <scan.json> <report.md>
// Writes <report.md> plus <report.md>.counts with key=value totals.

import { readFileSync, writeFileSync } from "node:fs";
import { reasonLabel } from "../../../src/report.mjs";

const ROW_CAP = 50; // keep issues a readable size on very branch-heavy repos

export function prLabel(pr) {
  if (!pr) return "-";
  const state =
    pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : pr.isDraft ? "draft" : "open";
  return `${state} #${pr.number}`;
}

function mergedText(b) {
  if (b.merged) return "yes";
  if (b.contentMerged) return "squash";
  return "-";
}

function tableRows(branches, cap) {
  const rows = branches.slice(0, cap).map((b) => {
    const status = b.verdict === "delete" ? "🔴" : "🟡";
    const cell = (s) => `| ${s} `;
    return (
      cell(status) +
      cell(`\`${b.name}\``) +
      cell(b.type) +
      cell(`${b.ageDays}d`) +
      cell(mergedText(b)) +
      cell(prLabel(b.pr)) +
      `| ${reasonLabel(b)} |`
    );
  });
  const hidden = branches.length - Math.min(branches.length, cap);
  if (hidden > 0) rows.push(`| | _… and ${hidden} more_ | | | | | |`);
  return rows.join("\n");
}

export function render(report, opts = {}) {
  const cap = opts.rowCap ?? ROW_CAP;
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const out = [];
  out.push(`## 🔴 git-cleanup scan report`);
  out.push(`_${now} · thresholds: merged ${report.config?.deleteMergedAfterDays ?? "?"}d · stale ${report.config?.warnUnmergedAfterDays ?? "?"}d_`);

  const totals = { delete: 0, warn: 0, keep: 0, repos: 0, errors: 0 };

  for (const repo of report.repos ?? []) {
    totals.repos += 1;
    if (repo.error) {
      totals.errors += 1;
      out.push("");
      out.push(`### ⚠️ ${repo.path}`);
      out.push(`\`${repo.error}\``);
      continue;
    }
    const branches = repo.branches ?? [];
    const del = branches.filter((b) => b.verdict === "delete");
    const warn = branches.filter((b) => b.verdict === "warn");
    totals.delete += del.length;
    totals.warn += warn.length;
    totals.keep += branches.length - del.length - warn.length;

    out.push("");
    out.push(`### 📦 ${repo.path}`);
    const meta = [];
    if (repo.baseRefs?.length) meta.push(`base: ${repo.baseRefs.join(", ")}`);
    if (repo.headBranch) meta.push(`HEAD: ${repo.headBranch}`);
    if (repo.pr?.repo) meta.push(`PRs: ${repo.pr.repo.owner}/${repo.pr.repo.repo} (${repo.pr.source})`);
    if (meta.length) out.push(`_${meta.join(" · ")}_`);
    out.push(`**${del.length} prunable · ${warn.length} stale · ${branches.length - del.length - warn.length} kept**`);

    if (del.length === 0 && warn.length === 0) {
      out.push("");
      out.push("✅ No prunable or stale branches.");
      continue;
    }
    if (del.length > 0) {
      out.push("");
      out.push(`#### Prunable (${del.length})`);
      out.push(`| | Branch | Type | Age | Merged | PR | Reason |`);
      out.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      out.push(tableRows(del, cap));
      out.push("");
      out.push(`Delete with \`git-cleanup prune${del.some((b) => b.type === "remote") ? " --remote" : ""}\` after reviewing.`);
    }
    if (warn.length > 0) {
      out.push("");
      out.push(`#### Stale — needs a human decision (${warn.length})`);
      out.push(`| | Branch | Type | Age | Merged | PR | Reason |`);
      out.push(`| --- | --- | --- | --- | --- | --- | --- |`);
      out.push(tableRows(warn, cap));
      out.push("");
      out.push("Stale branches are never deleted automatically — review and delete manually or add a force rule.");
    }
  }

  if (totals.errors > 0) {
    out.push("");
    out.push(`⚠️ ${totals.errors} of ${totals.repos} repositories could not be scanned.`);
  }
  return {
    markdown: out.join("\n") + "\n",
    counts: {
      prunable: totals.delete,
      stale: totals.warn,
      kept: totals.keep,
      repos: totals.repos,
      errors: totals.errors,
    },
  };
}

function main() {
  const [, , jsonPath, mdPath] = process.argv;
  if (!jsonPath || !mdPath) {
    console.error("usage: node report.mjs <scan.json> <report.md>");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(jsonPath, "utf8"));
  const { markdown, counts } = render(report);
  writeFileSync(mdPath, markdown);
  writeFileSync(
    `${mdPath}.counts`,
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
  process.exit(counts.errors > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("report.mjs")) {
  main();
}
