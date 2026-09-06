// git-cleanup sweep — one pass over every configured repo.
//
// Sweep is the automation command: it walks the config's `repos` list,
// applies each repo's mode ("report" — never deletes — or "prune"), and
// produces a single markdown report plus one JSON document for the whole
// run, optionally posting the report as a forge issue.
//
// Safety-first by construction: the default mode is "report", so a sweep
// with no config deletes nothing. Even in "prune" mode every deletion goes
// through the same confirmed() gate as `git-cleanup prune` — --yes (or an
// interactive yes) is required, and safety bundles are written before any
// force-delete or push-delete.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeRepo } from "./analyze.mjs";
import { pruneRepo } from "./prune.mjs";
import { countBranches } from "./report.mjs";
import { postReport, DEFAULT_TITLE } from "./report-issue.mjs";
import { providerFor } from "./forge.mjs";
import { c, plural } from "./util.mjs";
import { VERDICTS } from "./classify.mjs";

/** Combined markdown report for the whole sweep run. */
export function renderSweepMarkdown(docs, { dryRun = false } = {}) {
  const lines = [
    "# git-cleanup sweep report",
    "",
    `_${new Date().toISOString()}_${dryRun ? " · dry-run (nothing was changed)" : ""}`,
    "",
  ];
  for (const d of docs) {
    lines.push(`## ${d.path} \`(${d.mode})\``, "");
    if (d.notGit) {
      lines.push(`- ⚠️ error: ${d.error}`, "");
      continue;
    }
    lines.push(`- prunable: ${d.prunable} · stale: ${d.stale} · kept: ${d.kept}`);
    if (d.prunableBranches?.length) {
      lines.push(`- prunable: ${d.prunableBranches.join(", ")}`);
    }
    if (d.staleBranches?.length) {
      lines.push(`- stale: ${d.staleBranches.join(", ")}`);
    }
    if (d.wouldDelete?.length) {
      lines.push(`- would delete (dry-run): ${d.wouldDelete.join(", ")}`);
    }
    if (d.deletedLocal?.length) {
      lines.push(`- deleted local: ${d.deletedLocal.join(", ")}`);
    }
    if (d.deletedRemote?.length) {
      lines.push(`- deleted remote: ${d.deletedRemote.join(", ")}`);
    }
    if (d.prunedRemote?.length) {
      lines.push(`- pruned stale remote refs: ${d.prunedRemote.join(", ")}`);
    }
    if (d.deletedBackups?.length) {
      lines.push(`- removed ${d.deletedBackups.length} expired backup bundle(s)`);
    }
    if (d.backups?.length) {
      lines.push(`- backups written: ${d.backups.join(", ")}`);
    }
    for (const e of d.errors ?? []) lines.push(`- ✗ ${e}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Run a sweep over `repoSpecs` ({ path, mode? } each).
 * opts: { yes, remote, dryRun, reportFile }
 * Returns { json, docs, issue, report, dryRun, hadError } — json is the
 * single machine-readable document; nothing is printed here.
 */
export async function runSweep({ repoSpecs, cfg, opts, configDir }) {
  const dryRun = Boolean(opts.dryRun);
  const forceRemote = Boolean(opts.remote || cfg.sweep.remote);
  const docs = [];
  const raw = [];
  let hadError = false;

  for (const spec of repoSpecs) {
    const mode = spec.mode ?? cfg.sweep.mode;
    const r = await analyzeRepo(spec.path, cfg);
    const doc = { path: spec.path, mode };
    if (r.notGit) {
      doc.notGit = true;
      doc.error = r.error;
      hadError = true;
      docs.push(doc);
      raw.push(r);
      continue;
    }
    const counts = countBranches(r.branches);
    doc.prunable = counts.delete;
    doc.stale = counts.warn;
    doc.kept = counts.keep;
    doc.prunableBranches = r.branches
      .filter((b) => b.verdict === VERDICTS.DELETE)
      .map((b) => b.name);
    doc.staleBranches = r.branches
      .filter((b) => b.verdict === VERDICTS.WARN)
      .map((b) => b.name);
    doc.deletedLocal = [];
    doc.deletedRemote = [];
    doc.prunedRemote = [];
    doc.deletedBackups = [];
    doc.backups = [];
    doc.errors = [];
    if (mode === "prune") {
      if (dryRun) {
        // Mirror pruneRepo's eligibility without touching anything: DELETE
        // verdicts, remote ones only when --remote / sweep.remote is on.
        doc.wouldDelete = r.branches
          .filter((b) => b.verdict === VERDICTS.DELETE && (b.type === "local" || forceRemote))
          .map((b) => b.name);
      } else {
        const summary = await pruneRepo(r, cfg, {
          yes: opts.yes,
          remote: forceRemote,
          // JSON callers get exactly one JSON document on stdout; pruneRepo's
          // human block must not pollute it (backup notes move to stderr).
          silent: Boolean(opts.json),
        });
        doc.deletedLocal = summary.deletedLocal ?? [];
        doc.deletedRemote = summary.deletedRemote ?? [];
        doc.prunedRemote = summary.prunedRemote ?? [];
        doc.deletedBackups = summary.deletedBackups ?? [];
        doc.backups = (summary.backups ?? []).map((b) => b.file);
        doc.errors = (summary.errors ?? []).map((e) => `${e.name}: ${e.error}`);
        if (doc.errors.length) hadError = true;
      }
    }
    docs.push(doc);
    raw.push(r);
  }

  // Report file: --report wins; config sweep.reportFile resolves relative to
  // the config's directory (same rule as `repos` entries).
  let report = null;
  const reportFile = opts.reportFile ?? cfg.sweep.reportFile;
  if (reportFile) {
    const file = opts.reportFile ? resolve(reportFile) : resolve(configDir, reportFile);
    const markdown = renderSweepMarkdown(docs, { dryRun });
    writeFileSync(file, markdown);
    report = { file, written: true };
  }

  // Issue: post on the first repo with a recognized forge remote (the
  // "primary" repo). A configured issue with nowhere to post is a loud
  // failure, never a silent skip.
  let issue = null;
  if (cfg.sweep.reportIssue) {
    const hostMap = cfg.forge?.hosts ?? {};
    const primary = raw.find(
      (r) => !r.notGit && r.meta && providerFor(r.root, r.meta.remotes, hostMap).provider
    );
    if (!primary) {
      issue = {
        error:
          "no repo with a forge remote — sweep.reportIssue is set but there is nowhere to post",
      };
      hadError = true;
    } else {
      const found = providerFor(primary.root, primary.meta.remotes, hostMap);
      try {
        // The issue body is exactly the report file when one was written.
        const markdown = report
          ? readFileSync(report.file, "utf8")
          : renderSweepMarkdown(docs, { dryRun });
        const res = await postReport({
          markdown,
          title: cfg.sweep.reportIssue.title ?? DEFAULT_TITLE,
          dryRun,
          remoteUrl: found.url,
          hostMap,
        });
        issue = {
          dryRun: Boolean(res.dryRun),
          action: res.action,
          number: res.number ?? null,
          url: res.url ?? null,
        };
      } catch (e) {
        issue = { error: e.message };
        hadError = true;
      }
    }
  }

  return {
    json: {
      tool: "git-cleanup",
      command: "sweep",
      generatedAt: new Date().toISOString(),
      dryRun,
      mode: cfg.sweep.mode,
      report,
      issue,
      repos: docs,
    },
    docs,
    issue,
    report,
    dryRun,
    hadError,
  };
}

/** Human-readable rendering of a sweep run (colors, one line per repo). */
export function printSweep(result) {
  const out = [];
  const { docs, dryRun, issue, report } = result;
  const scanned = docs.filter((d) => !d.notGit).length;
  out.push(
    c.bold(
      `🌪 sweep: ${plural(docs.length, "repo")} · ${plural(scanned, "scanned")} · mode ${result.json.mode}${dryRun ? " · dry-run" : ""}`
    )
  );
  for (const d of docs) {
    if (d.notGit) {
      out.push(c.red(`  ✗ ${d.path}: ${d.error}`));
      continue;
    }
    const bits = [
      c.red(`${d.prunable} prunable`),
      c.yellow(`${d.stale} stale`),
      c.dim(`${d.kept} kept`),
    ];
    out.push(`  ${d.path} (${d.mode}): ${bits.join(" · ")}`);
    if (d.wouldDelete?.length) {
      out.push(c.yellow(`    would delete: ${d.wouldDelete.join(", ")}`));
    }
    if (d.deletedLocal.length) {
      out.push(c.green(`    ✓ deleted ${plural(d.deletedLocal.length, "local branch")}: ${d.deletedLocal.join(", ")}`));
    }
    if (d.deletedRemote.length) {
      out.push(c.green(`    ✓ deleted ${plural(d.deletedRemote.length, "remote branch")}: ${d.deletedRemote.join(", ")}`));
    }
    if (d.prunedRemote.length) {
      out.push(c.dim(`    ⤳ pruned ${plural(d.prunedRemote.length, "stale remote ref")}`));
    }
    if (d.deletedBackups.length) {
      out.push(c.dim(`    🧹 removed ${plural(d.deletedBackups.length, "expired backup bundle")}`));
    }
    for (const e of d.errors) out.push(c.red(`    ✗ ${e}`));
  }
  if (report) out.push(`  report: ${report.file}`);
  if (issue) {
    if (issue.error) out.push(c.red(`  issue: ${issue.error}`));
    else if (issue.dryRun) {
      out.push(
        c.dim(
          `  [dry-run] would ${issue.action === "updated" ? "update" : "create"} issue #${issue.number ?? "?"} — ${issue.url}`
        )
      );
    } else {
      out.push(c.green(`  issue: ${issue.action} #${issue.number} — ${issue.url}`));
    }
  }
  return out.join("\n");
}
