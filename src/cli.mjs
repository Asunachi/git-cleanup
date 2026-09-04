// git-cleanup CLI. Subcommands:
//   scan      (default) report prunable / stale branches
//   prune     delete merged branches (optionally --remote)
//   prs       list stale open PRs; --close to close them
//   help, --version

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.mjs";
import { analyzeRepo } from "./analyze.mjs";
import { printRepoReport, reposToJSON, actionableDelete } from "./report.mjs";
import { confirmed, pruneRepo } from "./prune.mjs";
import { closePR, stalePRs } from "./github.mjs";
import { c, plural } from "./util.mjs";
import { VERDICTS } from "./classify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
).version;

const USAGE = `git-cleanup ${VERSION} — prune stale/merged Git branches, cross-referenced with PR status

Usage:
  git-cleanup [scan] [options]        report branches that can be cleaned up
  git-cleanup prune [options]         delete merged/stale branches (asks first)
  git-cleanup prs [--close]           list stale open PRs (default: 30+ days)
  git-cleanup --version | --help

Options:
  -y, --yes              answer yes to every confirmation (for scripts/CI)
      --remote           also delete remote branches (git push --delete)
      --repo <path>      analyze this repo (overrides any config "repos" list)
      --config <file>    use this config file (highest-priority layer)
      --json             machine-readable output
      --check            exit code 2 when any branch is prunable
  -v, --verbose          show every branch (also clean ones)
      --no-pr            do not query GitHub for PR state
      --close            (prs only) close stale open PRs, with confirmation
  -V, --version          print the version
  -h, --help             show this help

Exit codes: 0 ok · 1 error · 2 (with --check) cleanup needed

Config is read from ~/.config/git-cleanup/config.json and .gitcleanup.json
(searched from the current directory upward). See README.md for the schema.
`;

function parseArgs(argv) {
  const opts = {
    yes: false,
    remote: false,
    json: false,
    check: false,
    verbose: false,
    pr: true,
    configFile: null,
    repoFlags: [],
    help: false,
    version: false,
    close: false,
  };
  let command = "scan";
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "scan":
      case "prune":
      case "prs":
      case "help":
        command = a;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--remote":
        opts.remote = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--check":
        opts.check = true;
        break;
      case "-v":
      case "--verbose":
        opts.verbose = true;
        break;
      case "--no-pr":
        opts.pr = false;
        break;
      case "--close":
        opts.close = true;
        break;
      case "--config":
        opts.configFile = next();
        break;
      case "--repo":
        opts.repoFlags.push(next());
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-V":
      case "--version":
        opts.version = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new Error(`unknown option: ${a}\n\n${USAGE}`);
        }
        positional.push(a);
        break;
    }
    if (opts.configFile === undefined || opts.repoFlags.includes(undefined)) {
      throw new Error(`missing value for ${a}\n\n${USAGE}`);
    }
  }
  if (positional.length > 0 && !["help"].includes(command)) {
    throw new Error(`unexpected argument: ${positional[0]}\n\n${USAGE}`);
  }
  return { command, opts };
}

async function analyzeAll(repos, cfg) {
  const results = await Promise.all(
    repos.map((p) => analyzeRepo(p, cfg))
  );
  return results;
}

async function cmdScan(results, cfg, opts) {
  if (opts.json) {
    console.log(JSON.stringify(reposToJSON(results, cfg), null, 2));
    return;
  }
  let total = { delete: 0, warn: 0, remote: 0 };
  for (const r of results) {
    if (r.notGit) {
      console.error(c.red(`error: ${r.error}`));
      continue;
    }
    console.log(printRepoReport(r, cfg, { verbose: opts.verbose }));
    for (const b of r.branches) {
      if (b.verdict === VERDICTS.DELETE) total.delete++;
      if (b.verdict === VERDICTS.WARN) total.warn++;
      if (b.verdict === VERDICTS.DELETE && b.type === "remote") total.remote++;
    }
  }
}

async function cmdPrune(results, cfg, opts) {
  let deletedLocal = 0;
  let deletedRemote = 0;
  let removedBackups = 0;
  let errors = 0;
  for (const r of results) {
    if (r.notGit) {
      console.error(c.red(`error: ${r.error}`));
      errors++;
      continue;
    }
    const summary = await pruneRepo(r, cfg, { yes: opts.yes, remote: opts.remote });
    deletedLocal += summary.deletedLocal?.length ?? 0;
    deletedRemote += summary.deletedRemote?.length ?? 0;
    removedBackups += summary.deletedBackups?.length ?? 0;
    errors += summary.errors?.length ?? 0;
    for (const e of summary.errors ?? []) {
      console.error(c.red(`  ✗ ${e.name}: ${e.error}`));
    }
  }
  if (deletedLocal + deletedRemote + removedBackups + errors > 0) {
    console.log("");
    const bits = [];
    if (deletedLocal) bits.push(c.green(`deleted ${plural(deletedLocal, "local branch")}`));
    if (deletedRemote) bits.push(c.green(`deleted ${plural(deletedRemote, "remote branch")}`));
    if (removedBackups)
      bits.push(c.dim(`removed ${plural(removedBackups, "stale backup bundle")}`));
    if (errors) bits.push(c.red(`${errors} failed`));
    console.log(`  ${bits.join(" · ")}`);
  }
  return errors > 0 ? 1 : 0;
}

async function cmdPrs(results, cfg, opts) {
  const reportThreshold = cfg.pr.staleAfterDays;
  const closeThreshold =
    cfg.pr.closeStaleAfterDays > 0 ? cfg.pr.closeStaleAfterDays : reportThreshold;
  let anyNotGit = false;
  for (const r of results) {
    if (r.notGit) {
      anyNotGit = true;
      console.error(c.red(`error: ${r.error}`));
    }
  }
  if (anyNotGit && results.every((r) => r.notGit)) return 1;
  // A repo that could not be read is an error even when other repos listed
  // PRs fine, so surface it through the exit code.
  const done = (code) => (anyNotGit ? 1 : code);
  const usable = results.filter((r) => !r.notGit && r.pr.source !== "none");
  const unusable = results.filter((r) => !r.notGit && r.pr.source === "none");

  let found = false;
  for (const r of usable) {
    const stale = stalePRs(r.pr.prs, reportThreshold);
    if (stale.length === 0) {
      if (!opts.json) console.log(c.green(`  ${r.path}: no stale PRs 🎉`));
      continue;
    }
    found = true;
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            path: r.path,
            repo: r.pr.repo,
            staleAfterDays: reportThreshold,
            prs: stale.map((p) => ({
              number: p.number,
              title: p.title,
              state: p.state,
              isDraft: p.isDraft,
              ageDays: p.ageDays,
              url: p.url,
            })),
          },
          null,
          2
        )
      );
      continue;
    }
    console.log(c.bold(`\n📦 ${r.path}  (${r.pr.repo.owner}/${r.pr.repo.repo})`));
    for (const p of stale) {
      console.log(
        `  ${c.yellow("•")} #${p.number} ${c.dim(`${p.ageDays}d`)}  ${p.title}${p.isDraft ? c.dim(" [draft]") : ""}`
      );
    }
  }
  for (const r of unusable) {
    if (r.pr?.repo && r.pr?.error && !opts.json) {
      console.error(c.yellow(`  ${r.path}: ${r.pr.error}`));
    }
  }
  if (!found && !opts.json) {
    console.log("\n  no stale open PRs found");
    return done(0);
  }
  if (!opts.close || !found) return done(0);

  const ok = await confirmed(
    `Close ${plural(
      usable.reduce(
        (n, r) => n + stalePRs(r.pr.prs, closeThreshold).length,
        0
      ),
      "stale PR"
    )}?`,
    false,
    opts
  );
  if (!ok) {
    console.log(c.dim("  skipped."));
    return done(0);
  }
  let closed = 0;
  let failed = 0;
  for (const r of usable) {
    for (const p of stalePRs(r.pr.prs, closeThreshold)) {
      try {
        await closePR({
          owner: r.pr.repo.owner,
          repo: r.pr.repo.repo,
          source: r.pr.source,
          pr: p,
          comment: cfg.pr.closeComment,
        });
        console.log(c.green(`  ✓ closed #${p.number} (${p.title.slice(0, 60)})`));
        closed++;
      } catch (e) {
        console.error(c.red(`  ✗ #${p.number}: ${e.message}`));
        failed++;
      }
    }
  }
  console.log(
    failed > 0
      ? c.yellow(`  ${closed} closed · ${failed} failed`)
      : c.green(`  ${closed} stale PRs closed`)
  );
  return done(failed > 0 ? 1 : 0);
}

export async function main(argv = process.argv.slice(2)) {
  let command, opts;
  try {
    ({ command, opts } = parseArgs(argv));
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
  if (opts.help || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }

  let loaded;
  try {
    loaded = loadConfig({
      configFile: opts.configFile,
      repoFlags: opts.repoFlags,
      cwd: process.cwd(),
    });
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
  const { cfg, repos } = loaded;
  if (!opts.pr) cfg.pr.track = false;

  let results;
  try {
    results = await analyzeAll(repos, cfg);
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }

  try {
    if (command === "scan") {
      await cmdScan(results, cfg, opts);
      // Errors (e.g. a configured repo is not a git repo) beat --check's
      // "cleanup needed" signal: report failure rather than a false clean.
      if (results.some((r) => r.notGit)) return 1;
      if (opts.check) {
        const any = results.some((r) => actionableDelete(r.branches ?? []).length > 0);
        return any ? 2 : 0;
      }
      return 0;
    }
    if (command === "prune") {
      return await cmdPrune(results, cfg, opts);
    }
    if (command === "prs") {
      return await cmdPrs(results, cfg, opts);
    }
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
  return 0;
}
