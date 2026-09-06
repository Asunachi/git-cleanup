// The `doctor` command: one diagnostic pass over everything git-cleanup
// depends on — git, the gh CLI, per-forge tokens, config validity
// (including `forge.hosts` claims), and remote detection for the repo at
// hand. Prints a report with fix hints; exit code 1 when anything is
// actually broken (missing tokens or an unrecognized remote are warnings —
// pure-git cleanup still works — they never fail the run).
//
// The checks are pure data (runDoctor) so tests can drive them with a
// stubbed `spawn`; rendering (printDoctor) is the CLI's job.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoMeta } from "./git.mjs";
import { detectForge, remoteHost, providers } from "./forge.mjs";
import { loadConfig } from "./config.mjs";
import { c } from "./util.mjs";

/** Home config path, computed per call so an exported session honors a
 * changed HOME (tests, embedding) instead of caching the import-time value. */
const homeConfig = () => join(homedir(), ".config", "git-cleanup", "config.json");

/** The token each forge uses, in display order. GitLab's CI_JOB_TOKEN
 * fallback is honored by the check itself. */
export const FORGE_TOKENS = [
  { forge: "github", envVar: "GITHUB_TOKEN" },
  { forge: "gitlab", envVar: "GITLAB_TOKEN" },
  { forge: "bitbucket", envVar: "BITBUCKET_TOKEN" },
  { forge: "gitea", envVar: "GITEA_TOKEN" },
];

const GIT_HINT =
  "git not found — install git (brew install git / apt install git / winget install Git.Git); nothing else can run without it";
const GH_HINT =
  "CLI not installed — GitHub PR reads fall back to GITHUB_TOKEN (slower, no gh auth needed); install gh for the fast path (brew install gh)";

function tokenNote(forge, env) {
  if (env[forge.envVar]) return null;
  if (forge.forge === "gitlab" && env.CI_JOB_TOKEN) {
    return "CI_JOB_TOKEN fallback set (Issues API writes need extra job-token permissions)";
  }
  return `not set — set ${forge.envVar} to enable ${forge.forge} PR enrichment and report-issue`;
}

/**
 * Run every check. Options:
 *   cwd        directory to inspect for a repo + config (default: process.cwd())
 *   env        environment to read tokens from (default: process.env)
 *   configFile --config override (default: none)
 *   homeFile   home config path (default: the real one, computed per call;
 *              tests point at a missing file so a developer's real config
 *              never leaks in)
 *   spawn      spawnSync-compatible runner (tests stub gh via this)
 * Returns a JSON-serializable document:
 *   { ok, counts: {ok, warn, error}, git, gh, tokens, config, repo }
 * `ok` is true when there are no errors; warnings never fail.
 */
export function runDoctor({ cwd = process.cwd(), env = process.env, configFile = null, homeFile = null, spawn = spawnSync } = {}) {
  const run = (cmd, args) => spawn(cmd, args, { encoding: "utf8", cwd });

  const gitOut = run("git", ["--version"]);
  const git =
    gitOut.status === 0 && gitOut.stdout
      ? {
          status: "ok",
          // "git version 2.43.0" -> "2.43.0" (the row already labels git)
          version: String(gitOut.stdout).trim().split("\n")[0].replace(/^git version /, ""),
        }
      : { status: "error", message: GIT_HINT };

  const ghOut = run("gh", ["--version"]);
  const gh =
    ghOut.status === 0 && ghOut.stdout
      ? {
          status: "ok",
          // "gh version 2.50.0 (2024-08-19)" -> "2.50.0 (2024-08-19)"
          version: String(ghOut.stdout).trim().split("\n")[0].replace(/^gh version /, ""),
        }
      : { status: "warn", message: GH_HINT };

  const tokens = FORGE_TOKENS.map((f) => ({
    forge: f.forge,
    envVar: f.envVar,
    set: Boolean(env[f.envVar]) || (f.forge === "gitlab" && Boolean(env.CI_JOB_TOKEN)),
    note: tokenNote(f, env),
  }));

  let config;
  try {
    const loaded = loadConfig({ configFile, cwd, homeFile: homeFile ?? homeConfig() });
    config = {
      status: "ok",
      sources: loaded.sources,
      forgeHosts: loaded.cfg.forge?.hosts ?? {},
    };
  } catch (e) {
    config = { status: "error", message: e.message };
  }
  const hostMap = config.status === "ok" ? config.forgeHosts : {};

  let repo;
  const meta = repoMeta(cwd);
  if (!meta) {
    repo = {
      status: "warn",
      path: cwd,
      message: `not inside a git repository (${cwd}) — remote detection skipped`,
      remotes: [],
    };
  } else {
    const remotes = [];
    for (const name of meta.remotes) {
      const r = run("git", ["remote", "get-url", name]);
      if (r.status !== 0) continue;
      const url = String(r.stdout ?? "").trim();
      const host = remoteHost(url);
      const forge = detectForge(url, hostMap);
      if (!forge) {
        remotes.push({
          name,
          url,
          host,
          forge: null,
          status: "warn",
          message: host
            ? `unrecognized host (${host}) — pure-git cleanup only; claim it via forge.hosts, e.g. {"${host}": "gitea"}`
            : `could not parse remote URL (${url})`,
        });
        continue;
      }
      const claimed = Object.prototype.hasOwnProperty.call(hostMap, host);
      // bitbucket-server authenticates with the SAME BITBUCKET_TOKEN as
      // Cloud, so its remote row reports against that token's entry.
      const token =
        tokens.find((t) => t.forge === forge) ??
        (forge === "bitbucket-server" ? tokens.find((t) => t.forge === "bitbucket") : null);
      const missingToken = token && !token.set;
      remotes.push({
        name,
        url,
        host,
        forge,
        claimed,
        status: missingToken ? "warn" : "ok",
        message: missingToken
          ? `${providers[forge].id} (${host}${claimed ? ", claimed via forge.hosts" : ""}) — no ${token.envVar} set`
          : `${providers[forge].id} (${host}${claimed ? ", claimed via forge.hosts" : ""})`,
      });
    }
    repo = { status: "ok", path: meta.root, remotes };
    if (remotes.length === 0) {
      repo.status = "warn";
      repo.message = "no git remotes — remote detection skipped (nothing to track PRs for)";
    }
  }

  // Totals: git, gh, config, repo, the four tokens, and one line per remote
  // (only when the repo resolved). Warnings never fail the run.
  const remoteCount = repo.status === "ok" ? repo.remotes.length : 0;
  const total = 4 + tokens.length + remoteCount;
  const errors = (git.status === "error" ? 1 : 0) + (config.status === "error" ? 1 : 0);
  const warnings =
    (gh.status === "warn" ? 1 : 0) +
    tokens.filter((t) => !t.set).length +
    (repo.status === "warn" ? 1 : 0) +
    (repo.status === "ok" ? repo.remotes.filter((r) => r.status === "warn").length : 0);

  return {
    ok: errors === 0,
    counts: { ok: total - errors - warnings, warn: warnings, error: errors },
    git,
    gh,
    tokens,
    config,
    repo,
  };
}

/** Human report for the doctor document (see runDoctor). */
export function printDoctor(doc) {
  const lines = [];
  lines.push(c.bold("\ngit-cleanup doctor"));
  const mark = (s) => (s === "ok" ? c.green("✓") : s === "warn" ? c.yellow("⚠") : c.red("✗"));

  lines.push(`  ${mark(doc.git.status)} git ${doc.git.status === "ok" ? doc.git.version : doc.git.message}`);
  lines.push(`  ${mark(doc.gh.status)} gh ${doc.gh.status === "ok" ? doc.gh.version : doc.gh.message}`);

  for (const t of doc.tokens) {
    const tag = t.set ? "set" : "not set";
    lines.push(`  ${mark(t.set ? "ok" : "warn")} ${t.forge} token ${t.envVar} — ${t.set ? "set" : t.note}`);
  }

  if (doc.config.status === "ok") {
    lines.push(`  ${c.green("✓")} config: ${doc.config.sources.join(" < ")}`);
    const claims = Object.entries(doc.config.forgeHosts);
    if (claims.length > 0) {
      for (const [host, forge] of claims) {
        lines.push(`  ${c.dim(`    forge.hosts: ${host} → ${forge}`)}`);
      }
    }
  } else {
    lines.push(`  ${c.red(`✗ config: ${doc.config.message}`)}`);
  }

  if (doc.repo.status !== "ok") {
    lines.push(`  ${mark(doc.repo.status)} repo ${doc.repo.message ?? ""}`);
  } else {
    lines.push(`  ${c.green("✓")} repo ${doc.repo.path} — ${doc.repo.remotes.length} ${doc.repo.remotes.length === 1 ? "remote" : "remotes"}`);
    for (const r of doc.repo.remotes) {
      lines.push(`  ${mark(r.status)} ${r.name} → ${r.message}`);
    }
  }

  const { ok, warn, error } = doc.counts;
  lines.push(c.dim(`\n  ${ok} ok · ${warn} warning${warn === 1 ? "" : "s"} · ${error} error${error === 1 ? "" : "s"}`));
  if (!doc.ok) lines.push(c.red("  something is broken — fix the ✗ items above and re-run doctor"));
  else if (warn > 0) lines.push(c.dim("  warnings are optional improvements — cleanup still works without them"));
  else lines.push(c.dim("  everything looks good"));
  return lines.join("\n");
}
