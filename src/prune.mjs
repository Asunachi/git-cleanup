// Execution of deletions. Never deletes anything without an explicit
// interactive confirmation (or --yes on the command line).

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, resolveRef } from "./git.mjs";
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

/**
 * Confirm an action; --yes or GIT_CLEANUP_YES skips asking.
 * `nothingPhrase` ends the non-interactive error ("nothing was deleted" for
 * prune, "nothing was restored" for backup restore).
 */
export async function confirmed(label, defaultYes, opts, nothingPhrase = "nothing was deleted") {
  if (opts.yes || process.env.GIT_CLEANUP_YES === "1") return true;
  if (!interactive()) {
    throw new Error(
      `non-interactive session: pass --yes (or --force) to allow "${label}" (${nothingPhrase})`
    );
  }
  return ask(label, defaultYes);
}

// --- backups -----------------------------------------------------------------
// Deletions that lose unique commits — force -D of unmerged work, the -D of
// squash/rebase-merged branches (their SHAs are not in the base), and remote
// push-deletes — first write the refs into a timestamped git bundle. Merged
// local branches deleted with plain -d stay reachable from the base branch
// and need no backup — unless -d refuses (merged into a remote base but not
// the local HEAD), in which case the branch is force-deleted behind a
// safety bundle: the scan already proved its tip is an ancestor of a base
// ref, and the bundle covers even that ref vanishing later.
// Disable with config backup.enabled = false.

export function backupDir(repo, cfg) {
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
  // A unique file per bundle: the timestamp is the human-readable identity,
  // the counter guards the (rare) same-millisecond rerun so a later bundle
  // can never overwrite an earlier one inside the same repo.
  let stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let file = join(dir, `backup-${stamp}-${tag}.bundle`);
  for (let n = 2; existsSync(file); n++) {
    file = join(dir, `backup-${stamp}-${n}-${tag}.bundle`);
  }
  const r = git(["bundle", "create", file, ...branches.map((b) => b.ref)], {
    cwd: repo.root,
  });
  if (!r.ok) return { error: r.err || `git bundle create failed` };
  return { file };
}

function printBackupNote(file, tag, silent) {
  // Safety-critical feedback: when the caller runs JSON mode (silent), the
  // note goes to stderr so stdout stays one pure JSON document — the bundle
  // path also lands in the summary's `backups` field for machine consumers.
  const out = silent ? console.error : console.log;
  out(c.dim(`  💾 backed up → ${file}`));
  if (tag === "remote") {
    out(
      c.dim(
        `     restore: git fetch <bundle> "+refs/remotes/*:refs/remotes/*"  (then git push origin to restore on the server)`
      )
    );
  } else {
    out(
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

function deleteLocalBranches(repo, cfg, branches) {
  const done = [];
  const errors = [];
  const backedUp = [];
  for (const b of branches) {
    // TOCTOU guard: the branch must still point at the commit the scan
    // analyzed, and an ancestor-merged branch must still be merged into the
    // base. A branch that moved (force-push, fast-forward, someone's rebase)
    // between scan and deletion is left alone — the next scan re-judges it.
    const guard = guardLocalDeletion(repo, b);
    if (!guard.ok) {
      errors.push({ name: b.name, error: guard.error });
      continue;
    }
    const flag = b.merged ? "-d" : "-D";
    const r = git(["branch", flag, b.name], { cwd: repo.root });
    if (r.ok) {
      done.push(b.name);
      continue;
    }
    if (flag === "-d") {
      // Plain -d refused — typically because the branch is merged into a
      // remote base branch but not into the local HEAD. The tool already
      // proved b.merged via `for-each-ref --merged <base>`, so the commits
      // stay reachable from the base ref; force-delete after writing a
      // safety bundle (covers even a base ref that vanishes between the
      // scan and the deletion). A failed backup aborts, nothing deleted.
      const bk = backupBranches(repo, cfg, [b], "force");
      if (bk.error) {
        errors.push({
          name: b.name,
          error: `backup failed — nothing deleted: ${bk.error}`,
        });
        continue;
      }
      if (bk.file) {
        backedUp.push({ file: bk.file, branches: [b.name] });
      }
      const r2 = git(["branch", "-D", b.name], { cwd: repo.root });
      if (r2.ok) {
        done.push(b.name);
        continue;
      }
      // -D refused too (e.g. the branch is checked out in another worktree):
      // report the real reason, not the -d one.
      errors.push({ name: b.name, error: r2.err || "git branch -D failed" });
      continue;
    }
    errors.push({ name: b.name, error: r.err || `git branch ${flag} failed` });
  }
  return { done, errors, backedUp };
}

/**
 * Re-verify a local branch right before deleting it: it must still exist at
 * the exact SHA the scan analyzed, and if the scan called it ancestor-merged
 * the branch tip must still be an ancestor of a base ref. Returns
 * { ok: true } or { ok: false, error }.
 */
function guardLocalDeletion(repo, b) {
  const current = resolveRef(repo.root, b.ref ?? b.name);
  if (!current) {
    return { ok: false, error: "branch disappeared between scan and delete — skipping" };
  }
  if (b.sha && current !== b.sha) {
    return {
      ok: false,
      error: `branch moved since scan (${b.sha.slice(0, 12)} → ${current.slice(0, 12)}) — skipping; re-run scan`,
    };
  }
  if (b.merged) {
    for (const base of repo.baseRefs ?? []) {
      if (git(["merge-base", "--is-ancestor", current, base], { cwd: repo.root }).ok) {
        return { ok: true };
      }
    }
    return { ok: false, error: "branch is no longer merged into any base branch — skipping" };
  }
  return { ok: true };
}

function deleteRemoteBranches(repo, branches) {
  const done = [];
  const pruned = [];
  const errors = [];
  const byRemote = new Map();
  for (const b of branches) {
    if (!byRemote.has(b.remoteName)) byRemote.set(b.remoteName, []);
    byRemote.get(b.remoteName).push(b);
  }
  for (const [remote, list] of byRemote) {
    for (const b of list) {
      const tracking = `${remote}/${b.shortName}`;
      // TOCTOU guard: only delete the remote branch if it still points at
      // the SHA this run analyzed. The local tracking ref is checked first;
      // then --force-with-lease makes the push itself atomic against the
      // server, so a branch that moved after the scan is never deleted
      // silently — it surfaces as an error instead (unless it is already
      // gone, which the ls-remote fallback below handles).
      const trackingSha = resolveRef(repo.root, tracking);
      if (b.sha && trackingSha && trackingSha !== b.sha) {
        errors.push({
          name: tracking,
          error: `branch moved since scan (${b.sha.slice(0, 12)} → ${trackingSha.slice(0, 12)}) — skipping; re-run scan`,
        });
        continue;
      }
      if (b.sha && !trackingSha) {
        // The tracking ref vanished between scan and prune (e.g. a fetch
        // --prune). The remote branch may still exist and may have advanced;
        // without a lease anchor we cannot delete atomically, so we do not.
        errors.push({
          name: tracking,
          error: "cannot verify remote branch state (tracking ref gone) — skipping; re-run scan",
        });
        continue;
      }
      const lease =
        b.sha && trackingSha
          ? [`--force-with-lease=refs/heads/${b.shortName}:${trackingSha}`]
          : [];
      const r = git(["push", ...lease, remote, "--delete", b.shortName], { cwd: repo.root });
      if (r.ok) {
        git(["branch", "-rd", tracking], { cwd: repo.root });
        done.push(tracking);
        continue;
      }
      // push --delete failed. When the branch was already deleted on the
      // server (web UI, another machine, an earlier run), the server state
      // is already correct and only our stale tracking ref needs pruning.
      // Verified with ls-remote rather than parsing git's error text, which
      // is localized; and only when ls-remote itself works, so auth/network
      // failures (or a still-existing ref — e.g. branch protection refusing
      // the deletion) still surface as real errors.
      const ls = git(
        ["ls-remote", "--heads", remote, `refs/heads/${b.shortName}`],
        { cwd: repo.root }
      );
      if (ls.ok && ls.out.trim() === "") {
        git(["branch", "-rd", tracking], { cwd: repo.root });
        pruned.push(tracking);
        continue;
      }
      errors.push({
        name: tracking,
        error: r.err || "git push --delete failed (network/auth?)",
      });
    }
  }
  return { done, pruned, errors };
}

/**
 * Prune one analyzed repo.
 * opts: { yes, remote, silent } — silent suppresses human output so JSON
 * callers (sweep --json) keep stdout pure; backup notes move to stderr.
 * Returns a summary object; throws only on config/session problems.
 */
export async function pruneRepo(repo, cfg, opts = {}) {
  const silent = Boolean(opts.silent);
  const say = (...a) => {
    if (!silent) console.log(...a);
  };
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

  say(c.bold(`\n📦 ${repo.path}`));
  if (removedBackups.length > 0) {
    say(
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
    say(`  ${c.red("•")} ${c.red(b.name)}  ${c.dim(`${b.ageDays}d old${state}`)}${note}`);
  }
  if (!opts.remote && remote.length > 0) {
    say(
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
    prunedRemote: [],
    backups: [],
    deletedBackups: removedBackups,
    errors: [],
  };

  if (mergedLocal.length > 0) {
    const msg = `Delete ${plural(mergedLocal.length, "merged local branch")}?`;
    if (await confirmed(msg, true, opts)) {
      const res = deleteLocalBranches(repo, cfg, mergedLocal);
      summary.deletedLocal.push(...res.done);
      summary.errors.push(...res.errors);
      for (const bk of res.backedUp) {
        summary.backups.push(bk);
        printBackupNote(bk.file, "local", silent);
      }
      if (res.backedUp.length > 0) {
        say(
          c.dim(
            `  ${plural(
              res.backedUp.length,
              "branch"
            )} needed force-deletion: -d refused (merged into a remote base, not the local HEAD); commits stay reachable from the base.`
          )
        );
      }
    } else {
      say(c.dim("  skipped."));
    }
  }

  if (contentLocal.length > 0) {
    say(
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
          printBackupNote(bk.file, "local", silent);
        }
        const res = deleteLocalBranches(repo, cfg, contentLocal);
        summary.deletedLocal.push(...res.done);
        summary.errors.push(...res.errors);
      }
    } else {
      say(c.dim("  skipped."));
    }
  }

  if (forceLocal.length > 0) {
    say(
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
          printBackupNote(bk.file, "local", silent);
        }
        const res = deleteLocalBranches(repo, cfg, forceLocal);
        summary.deletedLocal.push(...res.done);
        summary.errors.push(...res.errors);
      }
    } else {
      say(c.dim("  skipped."));
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
          printBackupNote(bk.file, "remote", silent);
        }
        const res = deleteRemoteBranches(repo, remoteToDo);
        summary.deletedRemote.push(...res.done);
        summary.prunedRemote.push(...res.pruned);
        summary.errors.push(...res.errors);
        if (res.pruned.length > 0) {
          say(
            c.dim(
              `  ⤳ ${plural(
                res.pruned.length,
                "remote branch"
              )} already gone on the server — pruned the stale local tracking refs`
            )
          );
        }
      }
    } else {
      say(c.dim("  skipped."));
    }
  }

  const staleWarnings = repo.branches.filter((b) => b.verdict === VERDICTS.WARN).length;
  if (staleWarnings > 0) {
    say(
      c.dim(
        `  ${plural(staleWarnings, "branch")} flagged stale but kept (run git-cleanup scan to review)`
      )
    );
  }

  return summary;
}
