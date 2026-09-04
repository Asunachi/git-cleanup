// Execution of deletions. Never deletes anything without an explicit
// interactive confirmation (or --yes on the command line).

import { createInterface } from "node:readline";
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

  if (candidates.length === 0) {
    return { nothing: true, repo };
  }

  console.log(c.bold(`\n📦 ${repo.path}`));
  for (const b of candidates) {
    const note = b.type === "remote" ? c.dim("  [remote, push --delete]") : "";
    console.log(
      `  ${c.red("•")} ${c.red(b.name)}  ${c.dim(
        `${b.ageDays}d old${b.merged ? ", merged" : ", NOT merged"}`
      )}${note}`
    );
  }
  if (!opts.remote && remote.length > 0) {
    console.log(
      c.dim(
        `\n  ${plural(remote.length, "remote branch")} eligible — rerun with --remote to delete them.`
      )
    );
  }

  const mergedLocal = local.filter((b) => b.merged);
  const forceLocal = local.filter((b) => !b.merged);

  // Remote deletion only happens when the user passed --remote.
  const remoteToDo = opts.remote ? remote : [];

  const summary = { repo, deletedLocal: [], deletedRemote: [], errors: [] };

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

  if (forceLocal.length > 0) {
    console.log(
      c.yellow(
        `  ⚠ ${plural(forceLocal.length, "unmerged branch")} would be force-deleted (work is not in any base branch).`
      )
    );
    const msg = `Force-delete ${plural(forceLocal.length, "unmerged local branch")}?`;
    if (await confirmed(msg, false, opts)) {
      const res = deleteLocalBranches(repo, forceLocal);
      summary.deletedLocal.push(...res.done);
      summary.errors.push(...res.errors);
    } else {
      console.log(c.dim("  skipped."));
    }
  }

  if (remoteToDo.length > 0) {
    const msg = `Delete ${plural(remoteToDo.length, "remote branch")} (git push --delete)?`;
    if (await confirmed(msg, true, opts)) {
      const res = deleteRemoteBranches(repo, remoteToDo);
      summary.deletedRemote.push(...res.done);
      summary.errors.push(...res.errors);
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
