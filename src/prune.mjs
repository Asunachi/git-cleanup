// Execution of deletions. Never deletes anything without an explicit
// interactive confirmation (or --yes on the command line).

import { createInterface } from "node:readline";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./git.mjs";
import { VERDICTS } from "./classify.mjs";
import { c, plural } from "./util.mjs";

export function interactive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ask(question, defaultYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  return new Promise((resolve) => {
    rl.question(c.bold(question + suffix), (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

/** Confirm an action; --yes or GIT_CLEANUP_YES skips asking. */
export async function confirmed(label, defaultYes, opts) {
  if (opts.yes || process.env.GIT_CLEANUP_YES === "1") return true;
  if (!interactive()) {
    throw new Error(
      `non-interactive session: pass --yes to allow "${label}" (nothing was deleted)`
    );
  }
  return ask(label, defaultYes);
}

// --- backups -----------------------------------------------------------------
// Deletions that lose unique commits — force -D of unmerged work, the -D of
// squash/rebase-merged branches (their SHAs are not in the base), and remote
// push-deletes — first write the refs into a timestamped git bundle. Merged
// local branches deleted with plain -d stay reachable from the base branch
// and need no backup. Disable with config backup.enabled = false.

function backupDir(repo, cfg) {
  const dir = cfg.backup?.dir;
  if (dir) return resolve(dir);
  const gitDir = repo.meta?.gitDir ?? join(repo.root ?? ".", ".git");
  return join(gitDir, "git-cleanup-backups");
}

/**
 * Bundle `branches` (by full ref) into a fresh file, or return null when
 * backups are disabled. Returns { file } or { error }.
 */
function backupBranches(repo, cfg, branches, tag) {
  if (cfg.backup?.enabled === false || branches.length === 0) return { file: null };
  const dir = backupDir(repo, cfg);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { error: `cannot create backup dir ${dir}: ${e.message}` };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `backup-${stamp}-${tag}.bundle`);
  const r = git(["bundle", "create", file, ...branches.map((b) => b.ref)], {
    cwd: repo.root,
  });
  if (!r.ok) return { error: r.err || `git bundle create failed` };
  return { file };
}

function printBackupNote(file, tag) {
  console.log(c.dim(`  💾 backed up → ${file}`));
  if (tag === "remote") {
    console.log(
      c.dim(
        `     restore: git fetch <bundle> "+refs/remotes/*:refs/remotes/*"  (then git push origin to restore on the server)`
      )
    );
  } else {
    console.log(
      c.dim(`     restore: git fetch <bundle> "+refs/heads/*:refs/heads/*"  (from inside the repo)`)
    );
  }
}

/**
 * Retention: remove this repo's own backup bundles (backup-*.bundle) older
 * than cfg.backup.retainDays days. 0 (default) keeps everything. Unrelated
 * files in a custom backup.dir are never touched.
 */
function sweepRetention(repo, cfg) {
  const retain = cfg.backup?.retainDays ?? 0;
  if (retain <= 0) return [];
  const cutoff = Date.now() - retain * 24 * 60 * 60 * 1000;
  let dir;
  try {
    dir = backupDir(repo, cfg);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no backups yet
  }
  const removed = [];
  for (const name of entries) {
    if (!name.startsWith("backup-") || !name.endsWith(".bundle")) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).isFile() && statSync(file).mtimeMs < cutoff) {
        rmSync(file, { force: true });
        removed.push(file);
      }
    } catch {
      /* unreadable or already gone: leave it */
    }
  }
  return removed;
}

function deleteLocalBranches(repo, branches) {
  const done = [];
  const errors = [];
  for (const b of branches) {
    const flag = b.merged ? "-d" : "-D";
    const r = git(["branch", flag, b.name], { cwd: repo.root });
    if (r.ok) done.push(b.name);
    else {
      const detail = r.err || `git branch ${flag} failed`;
      const hint =
        flag === "-d"
          ? " (not merged into the current HEAD — check out the base branch and re-run)"
          : "";
      errors.push({ name: b.name, error: detail + hint });
    }
  }
  return { done, errors };
}

function deleteRemoteBranches(repo, branches) {
  const done = [];
  const errors = [];
  const byRemote = new Map();
  for (const b of branches) {
    if (!byRemote.has(b.remoteName)) byRemote.set(b.remoteName, []);
    byRemote.get(b.remoteName).push(b);
  }
  for (const [remote, list] of byRemote) {
    for (const b of list) {
      const r = git(["push", remote, "--delete", b.shortName], { cwd: repo.root });
      if (r.ok) {
        git(["branch", "-rd", `${remote}/${b.shortName}`], { cwd: repo.root });
        done.push(`${remote}/${b.shortName}`);
      } else {
        errors.push({
          name: `${remote}/${b.shortName}`,
          error: r.err || "git push --delete failed (network/auth?)",
        });
      }
    }
  }
  return { done, errors };
}

/**
 * Prune one analyzed repo.
 * opts: { yes, remote }
 * Returns a summary object; throws only on config/session problems.
 */
export async function pruneRepo(repo, cfg, opts = {}) {
  const candidates = repo.branches.filter(
    (b) => b.verdict === VERDICTS.DELETE
  );
  const local = candidates.filter((b) => b.type === "local");
  const remote = candidates.filter((b) => b.type === "remote");

  // Retention runs even when there is nothing else to prune, so a scheduled
  // no-op prune still sweeps expired backups.
  const removedBackups = sweepRetention(repo, cfg);
  if (candidates.length === 0 && removedBackups.length === 0) {
    return { nothing: true, repo, deletedBackups: [] };
  }

  console.log(c.bold(`\n📦 ${repo.path}`));
  if (removedBackups.length > 0) {
    console.log(
      c.dim(
        `  🧹 removed ${plural(
          removedBackups.length,
          "backup bundle"
        )} older than ${cfg.backup.retainDays}d (backup.retainDays)`
      )
    );
  }
  for (const b of candidates) {
    const note = b.type === "remote" ? c.dim("  [remote, push --delete]") : "";
    const state = b.merged
      ? ", merged"
      : b.contentMerged
        ? ", content merged (squash/rebase)"
        : ", NOT merged";
    console.log(`  ${c.red("•")} ${c.red(b.name)}  ${c.dim(`${b.ageDays}d old${state}`)}${note}`);
  }
  if (!opts.remote && remote.length > 0) {
    console.log(
      c.dim(
        `\n  ${plural(remote.length, "remote branch")} eligible — rerun with --remote to delete them.`
      )
    );
  }

  const mergedLocal = local.filter((b) => b.merged);
  const contentLocal = local.filter((b) => !b.merged && b.contentMerged);
  const forceLocal = local.filter((b) => !b.merged && !b.contentMerged);

  // Remote deletion only happens when the user passed --remote.
  const remoteToDo = opts.remote ? remote : [];

  const summary = {
    repo,
    deletedLocal: [],
    deletedRemote: [],
    backups: [],
    deletedBackups: removedBackups,
    errors: [],
  };

  if (mergedLocal.length > 0) {
    const msg = `Delete ${plural(mergedLocal.length, "merged local branch")}?`;
    if (await confirmed(msg, true, opts)) {
      const res = deleteLocalBranches(repo, mergedLocal);
      summary.deletedLocal.push(...res.done);
      summary.errors.push(...res.errors);
    } else {
      console.log(c.dim("  skipped."));
    }
  }

  if (contentLocal.length > 0) {
    console.log(
      c.dim(
        `  these look squash/rebase-merged: the branch tip's tree already exists in a base branch, but the original commits were rewritten.`
      )
    );
    const msg = `Delete ${plural(
      contentLocal.length,
      "squash/rebase-merged local branch"
    )}?`;
    if (await confirmed(msg, true, opts)) {
      const bk = backupBranches(repo, cfg, contentLocal, "squash");
      if (bk.error) {
        summary.errors.push({ name: "backup (squash)", error: bk.error });
        console.error(c.red(`  ✗ backup failed — nothing deleted: ${bk.error}`));
      } else {
        if (bk.file) {
          summary.backups.push({
            file: bk.file,
            branches: contentLocal.map((b) => b.name),
          });
          printBackupNote(bk.file, "local");
        }
        const res = deleteLocalBranches(repo, contentLocal);
        summary.deletedLocal.push(...res.done);
        summary.errors.push(...res.errors);
      }
    } else {
      console.log(c.dim("  skipped."));
    }
  }

  if (forceLocal.length > 0) {
    console.log(
      c.yellow(
        `  ⚠ ${plural(forceLocal.length, "unmerged branch")} would be force-deleted (work is not in any base branch).`
      )
    );
    const msg = `Force-delete ${plural(forceLocal.length, "unmerged local branch")}?`;
    if (await confirmed(msg, false, opts)) {
      const bk = backupBranches(repo, cfg, forceLocal, "force");
      if (bk.error) {
        summary.errors.push({ name: "backup (force)", error: bk.error });
        console.error(c.red(`  ✗ backup failed — nothing deleted: ${bk.error}`));
      } else {
        if (bk.file) {
          summary.backups.push({
            file: bk.file,
            branches: forceLocal.map((b) => b.name),
          });
          printBackupNote(bk.file, "local");
        }
        const res = deleteLocalBranches(repo, forceLocal);
        summary.deletedLocal.push(...res.done);
        summary.errors.push(...res.errors);
      }
    } else {
      console.log(c.dim("  skipped."));
    }
  }

  if (remoteToDo.length > 0) {
    const msg = `Delete ${plural(remoteToDo.length, "remote branch")} (git push --delete)?`;
    if (await confirmed(msg, true, opts)) {
      const bk = backupBranches(repo, cfg, remoteToDo, "remote");
      if (bk.error) {
        summary.errors.push({ name: "backup (remote)", error: bk.error });
        console.error(c.red(`  ✗ backup failed — nothing deleted: ${bk.error}`));
      } else {
        if (bk.file) {
          summary.backups.push({
            file: bk.file,
            branches: remoteToDo.map((b) => b.name),
          });
          printBackupNote(bk.file, "remote");
        }
        const res = deleteRemoteBranches(repo, remoteToDo);
        summary.deletedRemote.push(...res.done);
        summary.errors.push(...res.errors);
      }
    } else {
      console.log(c.dim("  skipped."));
    }
  }

  const staleWarnings = repo.branches.filter((b) => b.verdict === VERDICTS.WARN).length;
  if (staleWarnings > 0) {
    console.log(
      c.dim(
        `  ${plural(staleWarnings, "branch")} flagged stale but kept (run git-cleanup scan to review)`
      )
    );
  }

  return summary;
}
