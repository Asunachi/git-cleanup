// The `backup` command: make the git-bundle backups that prune writes before
// -D deletions visible and restorable:
//
//   git-cleanup backup list                        what's saved (and what a
//                                                  retention sweep would remove)
//   git-cleanup backup restore <bundle>            bring branches back
//
// Restore is additive and refuses to clobber: only refs that do not exist
// locally are fetched back (exact refspecs, no force); existing ones are
// skipped with a note. Overwriting could lose work, so it is never done
// automatically.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { git, repoMeta, resolveRef } from "./git.mjs";
import { backupDir, confirmed } from "./prune.mjs";
import { c, plural } from "./util.mjs";

/** The file naming sweepRetention also recognizes: only these are ours. */
const BACKUP_GLOB = /^backup-[^/]+\.bundle$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function repoOf(cwd) {
  const meta = repoMeta(cwd);
  if (!meta) throw new Error(`${cwd} is not inside a git repository`);
  return { root: meta.root, meta };
}

/** refs inside a bundle (from `git bundle list-heads`), or null. */
function bundleHeads(file) {
  const r = git(["bundle", "list-heads", file]);
  if (!r.ok) return null;
  const heads = [];
  for (const line of r.out.split("\n")) {
    const m = /^([0-9a-f]{40})\s+(refs\/.+)$/.exec(line);
    if (m) heads.push({ sha: m[1], ref: m[2] });
  }
  return heads;
}

/**
 * Every backup bundle of the repo at `cwd`, newest first, with the branches
 * it contains and whether a retention sweep would remove it.
 * Returns { dir, backups } (backups is [] when none exist yet).
 */
export function listBackupFiles(cwd, cfg) {
  const repo = repoOf(cwd);
  const dir = backupDir(repo, cfg);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, backups: [] }; // no backups yet
  }
  const retainMs = (cfg.backup?.retainDays ?? 0) * DAY_MS;
  const now = Date.now();
  const backups = [];
  for (const name of entries) {
    if (!BACKUP_GLOB.test(name)) continue;
    const file = join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue; // unreadable or already gone: skip, like the sweep does
    }
    if (!st.isFile()) continue;
    backups.push({
      name,
      file,
      sizeBytes: st.size,
      created: st.mtime.toISOString(),
      wouldSweep: retainMs > 0 && now - st.mtimeMs > retainMs,
      branches: bundleHeads(file)?.map((h) => h.ref) ?? [],
    });
  }
  backups.sort((a, b) => b.created.localeCompare(a.created));
  return { dir, backups };
}

/**
 * Restore branches from one backup bundle: resolve the bundle (a path, or a
 * basename in the backup dir), fetch back every ref in it that does not
 * exist locally, and skip the rest. Confirms first (--yes skips asking).
 * Returns { bundle, restored, skipped, existed? }.
 */
export async function restoreBackup({ cwd, cfg, name, yes = false }) {
  const repo = repoOf(cwd);
  // A basename is resolved against the backup dir first (even when it ends
  // in .bundle — that's the common case); anything else must be a path that
  // actually exists, so a typo never falls through to a wrong file.
  const { dir, backups } = listBackupFiles(cwd, cfg);
  let file = backups.find((b) => b.name === name)?.file ?? null;
  if (!file) {
    const candidate = isAbsolute(name) ? name : join(cwd, name);
    // Only real files count as bundle paths — an empty name or a directory
    // must not fall through to a confusing "cannot read bundle" error.
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      file = candidate;
    } else {
      const names = backups.map((b) => b.name).join(", ");
      throw new Error(
        `no backup named "${name}" in ${dir}${names ? ` — available: ${names}` : " (no backups yet)"}`
      );
    }
  }

  const heads = bundleHeads(file);
  if (!heads) throw new Error(`cannot read bundle ${file} (git bundle list-heads failed)`);
  const missing = [];
  const skipped = [];
  for (const h of heads) {
    if (!h.ref.startsWith("refs/heads/") && !h.ref.startsWith("refs/remotes/")) continue;
    if (resolveRef(cwd, h.ref)) skipped.push({ ref: h.ref, reason: "already exists locally" });
    else missing.push(h.ref);
  }
  const result = { bundle: basename(file), restored: [], skipped };
  if (missing.length === 0) {
    return skipped.length === 0
      ? { ...result, empty: true }
      : { ...result, existed: true };
  }

  await confirmed(
    `Restore ${plural(missing.length, "branch")} from ${basename(file)}?`,
    true,
    { yes },
    "nothing was restored"
  );
  const r = git(["fetch", file, ...missing.map((ref) => `${ref}:${ref}`)], { cwd });
  if (!r.ok) {
    throw new Error(`git fetch failed — nothing was restored: ${r.err || "unknown error"}`);
  }
  return { ...result, restored: missing };
}

// ---- rendering ---------------------------------------------------------------

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human report for listBackupFiles. */
export function printBackupList(doc, retainDays, path) {
  const lines = [c.bold(`\n📦 ${path}`), c.dim(`  backup dir: ${doc.dir}`)];
  if (doc.backups.length === 0) {
    lines.push(c.dim("  no backups yet — prune writes bundles before -D deletions"));
    return lines.join("\n");
  }
  for (const b of doc.backups) {
    const created = b.created.slice(0, 10);
    const branches = b.branches.length > 0 ? b.branches.join(", ") : "(empty)";
    lines.push(`  ${b.name}`);
    lines.push(
      c.dim(
        `    created ${created} · ${humanSize(b.sizeBytes)} · ${plural(b.branches.length, "branch")}: ${branches}`
      )
    );
    lines.push(c.dim(`    restore: git-cleanup backup restore ${b.name}`));
    if (b.wouldSweep) {
      lines.push(
        c.yellow(
          `  ⚠ older than backup.retainDays (${retainDays}d) — the next prune will sweep it`
        )
      );
    }
  }
  return lines.join("\n");
}
