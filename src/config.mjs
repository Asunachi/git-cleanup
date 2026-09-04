// Configuration discovery + merging.
//
// Precedence (later wins):
//   1. built-in defaults          (src/classify.mjs `defaults()`)
//   2. ~/.config/git-cleanup/config.json
//   3. .gitcleanup.json, found by walking up from the current directory
//   4. a file passed via --config
//
// `repos` entries are resolved relative to the directory of the config file
// that defines them (the cwd for the home-level config).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaults } from "./classify.mjs";

const CONFIG_NAMES = [".gitcleanup.json", ".git-cleanup.json"];
export const HOME_CONFIG = join(homedir(), ".config", "git-cleanup", "config.json");

export class ConfigError extends Error {}

function findUp(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const file = join(dir, name);
      try {
        readFileSync(file, "utf8");
        return file;
      } catch {
        /* keep looking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJSON(file) {
  try {
    const text = readFileSync(file, "utf8");
    const val = JSON.parse(text);
    if (val && typeof val === "object" && !Array.isArray(val)) return val;
    throw new ConfigError(`config ${file} must contain a JSON object`);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`cannot read config ${file}: ${e.message}`);
  }
}

/** Merge `over` on top of `base`; arrays and scalars replace, objects recurse. */
function deepMerge(base, over) {
  if (
    over === null ||
    typeof over !== "object" ||
    Array.isArray(over) ||
    base === null ||
    typeof base !== "object" ||
    Array.isArray(base)
  ) {
    return over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = deepMerge(base?.[k], v);
  }
  return out;
}

function clampNum(val, name) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`config key "${name}" must be a non-negative number`);
  }
  return n;
}

function checkBool(val, name) {
  if (typeof val !== "boolean") {
    throw new ConfigError(`config key "${name}" must be true or false`);
  }
  return val;
}

/**
 * Validate a raw config object and keep only the keys it actually provides,
 * so merged config layers fall through to defaults where they say nothing.
 */
export function normalizeConfig(raw) {
  const out = {};
  for (const key of ["deleteMergedAfterDays", "warnUnmergedAfterDays"]) {
    if (raw[key] !== undefined && raw[key] !== null) out[key] = clampNum(raw[key], key);
  }
  if (raw.pr && typeof raw.pr === "object") {
    const p = raw.pr;
    const norm = {};
    if (p.track !== undefined) norm.track = checkBool(p.track, "pr.track");
    for (const key of ["staleAfterDays", "closeStaleAfterDays"]) {
      if (p[key] !== undefined && p[key] !== null) norm[key] = clampNum(p[key], `pr.${key}`);
    }
    if (p.closeComment !== undefined) norm.closeComment = String(p.closeComment);
    out.pr = norm;
  }
  if (raw.remote && typeof raw.remote === "object") {
    const r = raw.remote;
    const norm = {};
    if (r.pruneMerged !== undefined) norm.pruneMerged = checkBool(r.pruneMerged, "remote.pruneMerged");
    if (r.deleteAbandonedAfterDays !== undefined && r.deleteAbandonedAfterDays !== null) {
      norm.deleteAbandonedAfterDays = clampNum(
        r.deleteAbandonedAfterDays,
        "remote.deleteAbandonedAfterDays"
      );
    }
    out.remote = norm;
  }
  if (Array.isArray(raw.protected)) out.protected = [...raw.protected];
  if (Array.isArray(raw.rules)) {
    out.rules = raw.rules.map((rule, i) => {
      if (!rule || typeof rule !== "object" || typeof rule.match !== "string") {
        throw new ConfigError(`rules[${i}] needs a "match" glob string`);
      }
      const norm = { match: rule.match };
      if (rule.mode === "merged" || rule.mode === "any") norm.mode = rule.mode;
      else if (rule.mode !== undefined) {
        throw new ConfigError(`rules[${i}].mode must be "merged" or "any"`);
      }
      if (rule.minAgeDays !== undefined && rule.minAgeDays !== null) {
        norm.minAgeDays = clampNum(rule.minAgeDays, `rules[${i}].minAgeDays`);
      }
      return norm;
    });
  }
  if (Array.isArray(raw.repos)) out.repos = [...raw.repos];
  return out;
}

/**
 * Load the effective config for a run.
 * Returns { cfg, repos, configDir, sources }
 *  - cfg: fully merged config with defaults applied
 *  - repos: absolute paths to analyze (already resolved)
 *  - configDir: directory used to resolve `repos` entries
 */
export function loadConfig({ configFile, repoFlags = [], cwd, homeFile = HOME_CONFIG }) {
  let cfg = defaults();
  const sources = ["defaults"];

  // Home-level config (repos resolve relative to cwd).
  let home = null;
  try {
    readFileSync(homeFile, "utf8");
    home = homeFile;
  } catch {
    /* not present */
  }
  if (home) {
    cfg = deepMerge(cfg, normalizeConfig(readJSON(home)));
    sources.push(home);
  }

  // Walk up from cwd. Always search: even with --config, a repo-level
  // .gitcleanup.json is a lower-priority layer that the explicit file
  // overrides on top of (see the precedence list at the top of this file).
  const found = findUp(cwd);
  if (found) {
    cfg = deepMerge(cfg, normalizeConfig(readJSON(found)));
    sources.push(found);
  }

  // Explicit --config file wins.
  let baseDir = cwd;
  if (configFile) {
    cfg = deepMerge(cfg, normalizeConfig(readJSON(configFile)));
    sources.push(configFile);
    baseDir = dirname(resolve(configFile));
  } else if (found) {
    baseDir = dirname(found);
  } else if (home) {
    baseDir = cwd; // home config: repos relative to where you run it
  }

  let repos;
  if (repoFlags.length > 0) {
    repos = repoFlags.map((p) => resolve(cwd, p));
  } else {
    repos = (cfg.repos ?? []).map((p) => resolve(baseDir, p));
    if (repos.length === 0) repos = [cwd];
  }

  return { cfg, repos, configDir: baseDir, sources };
}

