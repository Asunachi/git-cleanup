// git-cleanup CLI. Subcommands:
//   scan      (default) report prunable / stale branches
//   prune     delete merged branches (optionally --remote)
//   prs       list stale open PRs; --close to close them
//   report-issue  keep one issue with a fixed title current on any forge
//   help, --version

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.mjs";
import { analyzeRepo } from "./analyze.mjs";
import { countBranches, printRepoReport, reposToJSON, actionableDelete } from "./report.mjs";
import { confirmed, pruneRepo } from "./prune.mjs";
import { closePR, stalePRs, providerFor } from "./forge.mjs";
import { repoMeta } from "./git.mjs";
import { postReport, DEFAULT_TITLE } from "./report-issue.mjs";
import { printDoctor, runDoctor } from "./doctor.mjs";
import { listBackupFiles, printBackupList, restoreBackup } from "./backup.mjs";
import { runSweep, printSweep } from "./sweep.mjs";
import { c, plural } from "./util.mjs";
import { VERDICTS } from "./classify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
).version;

const USAGE = `git-cleanup ${VERSION} — prune stale/merged Git branches, cross-referenced with PR status

Commands:
  scan            report branches that can be cleaned up (default)
  prune           delete merged/stale branches (always asks first)
  prs             list stale open pull requests (--close to close them)
  sweep           walk every configured repo; prune by policy; one report
  report-issue    keep one issue with a fixed title current on any forge
  doctor          diagnose the environment (git, gh, tokens, config, remotes)
  backup          list backup bundles, or restore branches from one
  completions     print shell completions for bash, zsh, or fish
  shell-hook      print a shell or git hook snippet (bash, zsh, fish, pre-commit)
  help            show this help

Usage:
  git-cleanup [scan] [options]
  git-cleanup prune [options]
  git-cleanup prs [--close] [options]
  git-cleanup sweep [--report <file.md>] [--report-issue <title>] [--dry-run]
  git-cleanup report-issue <report.md> [--title <title>] [--dry-run]
  git-cleanup doctor [--json] [options]
  git-cleanup backup list [--json] [options]
  git-cleanup backup restore <bundle> [options]
  git-cleanup completions <bash|zsh|fish>
  git-cleanup shell-hook <bash|zsh|fish|pre-commit>
  git-cleanup --version | --help

Options:
  -y, --yes            answer yes to every confirmation (for scripts/CI)
      --force          alias for --yes ("just do it")
      --remote         also delete remote branches (git push --delete)
      --repo <path>    analyze this repo (repeatable; overrides config "repos")
      --config <file>  use this config file (highest-priority layer)
      --json           machine-readable output
      --summary        one line per repo: N prunable · M stale · K kept
      --check          exit code 2 when any branch is prunable (scan only)
  -v, --verbose        show every branch, including kept ones
      --no-pr          do not query GitHub/GitLab/Bitbucket for PR state
      --close          (prs only) close stale open PRs after confirmation
      --report <file>  (sweep only) write a combined markdown report here
      --report-issue <title>  (sweep only) post the report as a forge issue
      --title <t>      (report-issue only) exact issue title to keep current
      --dry-run        (report-issue/sweep) rehearsal: search, no writes
  -V, --version        print the version
  -h, --help           show this help

Examples:
  git-cleanup scan --verbose
  git-cleanup scan --check --json && echo "workspace is clean"   # CI gate
  git-cleanup prune --remote --yes                               # nightly cron
  git-cleanup prs --close                                        # stale-PR automator
  git-cleanup sweep --json                                       # whole workspace, machine-readable
  git-cleanup sweep --yes                                        # prune per config (sweep.mode)
  git-cleanup sweep --report-issue "Cleanup" --dry-run          # rehearse the issue post
  git-cleanup scan --json --repo . | node .github/actions/scan-report/report.mjs
  git-cleanup report-issue report.md --dry-run                   # rehearsal
  git-cleanup report-issue report.md                             # post (any forge)
  git-cleanup doctor                                           # why isn't PR tracking working?
  git-cleanup backup list                                      # what prune has saved
  git-cleanup backup restore backup-2026-09-05T22-38-42-618Z-force.bundle
  git-cleanup completions bash > ~/.local/share/bash-completion/completions/git-cleanup
  git-cleanup shell-hook bash >> ~/.bashrc                      # auto-scan on cd
  git-cleanup shell-hook pre-commit > .git/hooks/pre-commit     # remind on commit

Environment:
  GITHUB_TOKEN / GITLAB_TOKEN / BITBUCKET_TOKEN / GITEA_TOKEN  PR enrichment + report-issue
  BITBUCKET_TOKEN       Cloud and Server/Data Center share one token
  GITLAB_API_BASE / BITBUCKET_API_BASE / GITEA_API_BASE  override API bases
  GITHUB_API_BASE / CI_API_V4_URL                 report-issue API base overrides
  CI_JOB_TOKEN                         GitLab report-issue fallback auth
  GIT_CLEANUP_FETCH_TIMEOUT_MS                   forge API timeout (default 15000)
  GIT_CLEANUP_YES=1            same as --yes
  GIT_CLEANUP_NO_COLOR=1       disable ANSI colors (NO_COLOR also works)

Exit codes: 0 ok · 1 error · 2 (scan --check) cleanup needed

Config is read from ~/.config/git-cleanup/config.json and .gitcleanup.json
(searched from the current directory upward). See README.md for the schema.
`;

const SHELLS = ["bash", "zsh", "fish"];
const HOOKS = { bash: "git-cleanup.sh", zsh: "git-cleanup.sh", fish: "git-cleanup.fish", "pre-commit": "pre-commit" };

/** Print a shell or git hook snippet. */
function cmdShellHook(kind) {
  const file = HOOKS[kind];
  if (!file) {
    console.error(
      c.red(
        `error: unknown hook "${kind}" — expected one of: ${Object.keys(HOOKS).join(", ")}`
      )
    );
    return 1;
  }
  const path = join(__dirname, "..", "support", "dotfiles", file);
  try {
    process.stdout.write(readFileSync(path, "utf8"));
    return 0;
  } catch (e) {
    console.error(c.red(`error: cannot read ${path}: ${e.message}`));
    return 1;
  }
}

/** Keep one issue with the exact title current on the repo's forge. */
async function cmdReportIssue(opts, file) {
  if (opts.repoFlags.length > 1) {
    console.error(c.red("error: report-issue accepts a single --repo"));
    return 1;
  }
  const cwd = opts.repoFlags[0] || process.cwd();
  let markdown;
  try {
    markdown = readFileSync(file, "utf8");
  } catch (e) {
    console.error(c.red(`error: cannot read ${file}: ${e.message}`));
    return 1;
  }
  const meta = repoMeta(cwd);
  if (!meta) {
    console.error(c.red(`error: ${cwd} is not inside a git repository`));
    return 1;
  }
  // Config matters here: `forge.hosts` claims self-hosted forge hostnames
  // that the built-in detection cannot recognize. A broken config is loud.
  let hostMap = {};
  try {
    hostMap = loadConfig({ configFile: opts.configFile, cwd }).cfg.forge?.hosts ?? {};
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
  const found = providerFor(cwd, meta.remotes, hostMap);
  if (!found.provider) {
    console.error(
      c.red(
        "error: no supported forge remote found (providers: github, gitlab, bitbucket, bitbucket-server, gitea)"
      )
    );
    return 1;
  }
  const title = opts.title ?? DEFAULT_TITLE;
  try {
    const r = await postReport({
      markdown,
      title,
      dryRun: opts.dryRun,
      remoteUrl: found.url,
      hostMap,
    });
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    if (r.dryRun) {
      const verb = r.action === "updated" ? "update" : "create";
      const target = r.action === "updated" ? `issue #${r.number}` : `issue "${title}"`;
      console.log(`[dry-run] would ${verb} ${target} — ${r.url}`);
      console.log("[dry-run] no write performed — run without --dry-run to post for real");
      return 0;
    }
    console.log(`${r.action} issue #${r.number} — ${r.url}`);
    return 0;
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
}

/** Diagnose the environment: git, gh, tokens, config, remote detection. */
function cmdDoctor(opts) {
  if (opts.repoFlags.length > 1) {
    console.error(c.red("error: doctor accepts a single --repo"));
    return 1;
  }
  const cwd = opts.repoFlags[0] || process.cwd();
  const doc = runDoctor({ cwd, configFile: opts.configFile });
  if (opts.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.log(printDoctor(doc));
  }
  return doc.ok ? 0 : 1;
}

/** List or restore the git-bundle backups prune writes before -D deletions. */
async function cmdBackup(opts, sub, file) {
  if (opts.repoFlags.length > 1) {
    console.error(c.red("error: backup accepts a single --repo"));
    return 1;
  }
  const cwd = opts.repoFlags[0] || process.cwd();
  let cfg;
  try {
    cfg = loadConfig({ configFile: opts.configFile, repoFlags: opts.repoFlags, cwd }).cfg;
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
  try {
    if (sub === "list") {
      const doc = listBackupFiles(cwd, cfg);
      if (opts.json) {
        console.log(JSON.stringify({ ...doc, retainDays: cfg.backup?.retainDays ?? 0 }, null, 2));
      } else {
        console.log(printBackupList(doc, cfg.backup?.retainDays ?? 0, cwd));
      }
      return 0;
    }
    const r = await restoreBackup({ cwd, cfg, name: file, yes: opts.yes });
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    if (r.empty) {
      console.log(c.dim(`  ${r.bundle} contains no branch refs — nothing to restore`));
      return 0;
    }
    if (r.existed) {
      console.log(`  nothing to restore — every branch in ${r.bundle} already exists locally`);
      for (const s of r.skipped) console.log(c.dim(`    ${s.ref} — ${s.reason}`));
      return 0;
    }
    for (const ref of r.restored) console.log(`  ✓ restored ${ref}`);
    for (const s of r.skipped) console.log(c.dim(`  - ${s.ref} — ${s.reason}`));
    console.log(
      c.dim(`  restored ${plural(r.restored.length, "branch")} from ${r.bundle}`)
    );
    return 0;
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
}

/** One pass over every configured repo: scan, prune by policy, report. */
async function cmdSweep(loaded, opts) {
  const { cfg, repoSpecs, configDir } = loaded;
  // An explicit --report-issue always wins over config (and enables posting
  // even when the config said nothing).
  if (opts.reportIssueTitle) cfg.sweep.reportIssue = { title: opts.reportIssueTitle };
  try {
    const result = await runSweep({ repoSpecs, cfg, opts, configDir });
    if (opts.json) {
      console.log(JSON.stringify(result.json, null, 2));
    } else {
      console.log(printSweep(result));
    }
    return result.hadError ? 1 : 0;
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
}

/** Print shell completions for `shell` (bash | zsh | fish). */
function cmdCompletions(shell) {
  if (!SHELLS.includes(shell)) {
    console.error(
      c.red(`error: unknown shell "${shell}" — expected one of: ${SHELLS.join(", ")}`)
    );
    return 1;
  }
  const file = join(__dirname, "..", "support", "completions", `git-cleanup.${shell}`);
  try {
    process.stdout.write(readFileSync(file, "utf8"));
    return 0;
  } catch (e) {
    console.error(c.red(`error: cannot read ${file}: ${e.message}`));
    return 1;
  }
}

function parseArgs(argv) {
  const opts = {
    yes: false,
    remote: false,
    json: false,
    summary: false,
    check: false,
    verbose: false,
    pr: true,
    configFile: null,
    repoFlags: [],
    help: false,
    version: false,
    close: false,
    title: null,
    dryRun: false,
    reportFile: null,
    reportIssueTitle: null,
  };
  let command = "scan";
  let shell = null;
  let hookKind = null;
  let sub = null;
  let file = null;
  const positional = [];
  let i = 0;
  // Consume the value of a flag that takes one (--repo / --config). Refuses
  // a missing value AND a value that looks like another flag (--repo --json
  // must not silently swallow --json as the repo path).
  const takeValue = (flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) {
      throw new Error(`missing value for ${flag}\n\n${USAGE}`);
    }
    i += 1;
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "scan":
      case "prune":
      case "prs":
      case "sweep":
      case "report-issue":
      case "doctor":
      case "backup":
      case "help":
      case "completions":
      case "shell-hook":
        command = a;
        break;
      case "-y":
      case "--yes":
      case "--force":
        opts.yes = true;
        break;
      case "--remote":
        opts.remote = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--summary":
        opts.summary = true;
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
      case "--title":
        opts.title = takeValue("--title");
        break;
      case "--report":
        opts.reportFile = takeValue("--report");
        break;
      case "--report-issue":
        opts.reportIssueTitle = takeValue("--report-issue");
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--config":
        opts.configFile = takeValue("--config");
        break;
      case "--repo":
        opts.repoFlags.push(takeValue("--repo"));
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
  }
  if (command === "completions") {
    if (positional.length !== 1) {
      throw new Error(
        `completions needs one shell argument: ${SHELLS.join(", ")}\n\n${USAGE}`
      );
    }
    shell = positional[0];
  } else if (command === "shell-hook") {
    if (positional.length !== 1) {
      throw new Error(
        `shell-hook needs one argument: ${Object.keys(HOOKS).join(", ")}\n\n${USAGE}`
      );
    }
    hookKind = positional[0];
  } else if (command === "report-issue") {
    if (positional.length !== 1) {
      throw new Error(`report-issue needs one argument: <report.md>\n\n${USAGE}`);
    }
    file = positional[0];
  } else if (command === "backup") {
    if (positional.length < 1 || !["list", "restore"].includes(positional[0])) {
      throw new Error(`backup needs a subcommand: list or restore\n\n${USAGE}`);
    }
    sub = positional[0];
    if (sub === "list") {
      if (positional.length !== 1) {
        throw new Error(`backup list takes no arguments\n\n${USAGE}`);
      }
    } else if (positional.length !== 2) {
      throw new Error(`backup restore needs one argument: <bundle>\n\n${USAGE}`);
    } else {
      file = positional[1];
    }
  } else if (positional.length > 0 && !["help"].includes(command)) {
    throw new Error(`unexpected argument: ${positional[0]}\n\n${USAGE}`);
  }
  return { command, opts, shell, hookKind, sub, file };
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
  if (opts.summary) {
    // One line per repo — the shape shell hooks and prompt integrations want.
    for (const r of results) {
      if (r.notGit) {
        console.error(c.red(`error: ${r.error}`));
        continue;
      }
      const counts = countBranches(r.branches);
      const bits = [
        c.red(`${counts.delete} prunable`),
        c.yellow(`${counts.warn} stale`),
        c.dim(`${counts.keep} kept`),
      ];
      console.log(`📦 ${r.path}: ${bits.join(" · ")}`);
    }
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
  let prunedRemote = 0;
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
    prunedRemote += summary.prunedRemote?.length ?? 0;
    removedBackups += summary.deletedBackups?.length ?? 0;
    errors += summary.errors?.length ?? 0;
    for (const e of summary.errors ?? []) {
      console.error(c.red(`  ✗ ${e.name}: ${e.error}`));
    }
  }
  if (deletedLocal + deletedRemote + prunedRemote + removedBackups + errors > 0) {
    console.log("");
    const bits = [];
    if (deletedLocal) bits.push(c.green(`deleted ${plural(deletedLocal, "local branch")}`));
    if (deletedRemote) bits.push(c.green(`deleted ${plural(deletedRemote, "remote branch")}`));
    if (prunedRemote)
      bits.push(c.dim(`pruned ${plural(prunedRemote, "stale remote ref")}`));
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
  const notGit = results.filter((r) => r.notGit);
  for (const r of notGit) {
    console.error(c.red(`error: ${r.error}`));
  }
  // A repo that could not be read is an error even when other repos listed
  // PRs fine, so surface it through the exit code.
  const done = (code) => (notGit.length > 0 ? 1 : code);
  const usable = results.filter((r) => !r.notGit && r.pr.source !== "none");
  const unusable = results.filter((r) => !r.notGit && r.pr.source === "none");

  const prShape = (p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    ageDays: p.ageDays,
    url: p.url,
  });

  // Machine-readable mode always prints exactly ONE JSON document (never
  // empty, never concatenated objects, even when every repo failed) so
  // consumers always get a parseable array, in input order:
  //   { path, repo, staleAfterDays, prs: [...] }     repo could be scanned
  //   { path, repo, error }                           PR backend unavailable
  //   { path, error }                                 repo could not be read
  if (opts.json) {
    const doc = [];
    for (const r of results) {
      if (r.notGit) {
        doc.push({ path: r.path, error: r.error });
      } else if (r.pr.source === "none") {
        if (r.pr?.repo && r.pr?.error) {
          doc.push({
            path: r.path,
            repo: { owner: r.pr.repo.owner, repo: r.pr.repo.repo },
            error: r.pr.error,
          });
        }
      } else {
        doc.push({
          path: r.path,
          repo: r.pr.repo
            ? { owner: r.pr.repo.owner, repo: r.pr.repo.repo }
            : null,
          staleAfterDays: reportThreshold,
          truncated: r.pr.truncated || undefined,
          prs: stalePRs(r.pr.prs, reportThreshold).map(prShape),
        });
      }
    }
    console.log(JSON.stringify(doc, null, 2));
    if (!opts.close) return done(0);
  } else {
    if (notGit.length === results.length) return 1;
    let found = false;
    for (const r of usable) {
      const stale = stalePRs(r.pr.prs, reportThreshold);
      if (r.pr.truncated) {
        console.log(
          c.yellow(
            `  ⚠ ${r.path}: PR data truncated (fetch cap) — the oldest branches may be missing`
          )
        );
      }
      if (stale.length === 0) {
        console.log(c.green(`  ${r.path}: no stale PRs 🎉`));
        continue;
      }
      found = true;
      console.log(c.bold(`\n📦 ${r.path}  (${r.pr.repo.owner}/${r.pr.repo.repo})`));
      for (const p of stale) {
        console.log(
          `  ${c.yellow("•")} #${p.number} ${c.dim(`${p.ageDays}d`)}  ${p.title}${p.isDraft ? c.dim(" [draft]") : ""}`
        );
      }
    }
    for (const r of unusable) {
      // An error here means PR state could not be loaded at all — say so
      // even when there is no forge remote to attach the message to, so
      // "no stale PRs found" below is never mistaken for a real check.
      if (r.pr?.error) {
        console.error(c.yellow(`  ${r.path}: ${r.pr.error}`));
      }
    }
    if (!found) {
      if (usable.length === 0) {
        console.log("\n  no PR source available — nothing to list (add a GitHub/GitLab remote or set a token)");
      } else {
        console.log("\n  no stale open PRs found");
      }
      return done(0);
    }
    if (!opts.close) return done(0);
  }

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
          provider: r.pr.provider,
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
  let command, opts, shell, hookKind, sub, file;
  try {
    ({ command, opts, shell, hookKind, sub, file } = parseArgs(argv));
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
  if (command === "completions") {
    return cmdCompletions(shell);
  }
  if (command === "shell-hook") {
    return cmdShellHook(hookKind);
  }
  if (command === "report-issue") {
    return await cmdReportIssue(opts, file);
  }
  if (command === "doctor") {
    return cmdDoctor(opts);
  }
  if (command === "backup") {
    return await cmdBackup(opts, sub, file);
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

  if (command === "sweep") {
    return await cmdSweep(loaded, opts);
  }

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
