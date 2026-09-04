// Git introspection: everything we need to know about a repo's branches is
// gathered through the `git` binary so we never touch .git internals.

import { spawnSync } from "node:child_process";
import { daysBetween, isoFromUnix } from "./util.mjs";

export class GitError extends Error {}

/** Run git synchronously. Returns { ok, code, out, err }. */
export function git(args, opts = {}) {
  const res = spawnSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) {
    throw new GitError(`failed to run git: ${res.error.message}`);
  }
  return {
    ok: res.status === 0,
    code: res.status ?? -1,
    out: (res.stdout ?? "").trim(),
    err: (res.stderr ?? "").trim(),
  };
}

export function gitOk(args, opts) {
  return git(args, opts).ok;
}

/** Resolve a ref to its SHA, or null if the ref does not exist. */
export function resolveRef(cwd, ref) {
  const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
  return r.ok ? r.out : null;
}

/**
 * Identify the repository a directory lives in.
 * Returns null when the directory is not inside a git work tree.
 */
export function repoMeta(cwd) {
  const root = git(["rev-parse", "--show-toplevel"], { cwd });
  if (!root.ok) return null;

  const headRes = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  const head = headRes.ok ? headRes.out : null;

  const remotesOut = git(["remote"], { cwd });
  const remotes = remotesOut.ok
    ? remotesOut.out.split("\n").filter(Boolean)
    : [];

  // Determine each remote's default branch from local refs only (no network).
  // Prefer the remote-HEAD symref, then the local default branch's own
  // upstream (local-path clones do not always materialize origin/HEAD), then
  // the checked-out branch mirrored on the remote, then well-known names.
  const remoteDefault = {};
  for (const r of remotes) {
    let def = null;
    const sym = git(["symbolic-ref", "--quiet", `refs/remotes/${r}/HEAD`], { cwd });
    if (sym.ok) {
      def = sym.out.replace(/^refs\/remotes\/[^/]+\//, "");
    }
    if (!def && head) {
      const up = git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD@{upstream}"],
        { cwd }
      );
      if (up.ok && up.out.startsWith(`${r}/`)) {
        def = up.out.slice(r.length + 1);
      } else if (resolveRef(cwd, `refs/remotes/${r}/${head}`)) {
        def = head;
      }
    }
    if (!def) {
      for (const cand of ["main", "master", "trunk", "develop", "dev"]) {
        if (resolveRef(cwd, `refs/remotes/${r}/${cand}`)) {
          def = cand;
          break;
        }
      }
    }
    remoteDefault[r] = def;
  }

  return {
    root: root.out,
    headBranch: head,
    remotes,
    remoteDefault,
  };
}

const FORMAT = "%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(HEAD)";

/**
 * Enumerate branches.
 * kind: "heads" (local) or "remotes" (remote-tracking, e.g. origin/x).
 * Each entry: { name, ref, sha, commitUnix, isHead }
 */
export function listBranches(cwd, kind) {
  const prefix = kind === "heads" ? "refs/heads" : "refs/remotes";
  const r = git(["for-each-ref", prefix, `--format=${FORMAT}`], { cwd });
  if (!r.ok) return [];
  const out = [];
  for (const line of r.out.split("\n")) {
    if (!line) continue;
    const [name, sha, unix, headMarker] = line.split("\u001f");
    if (kind === "remotes" && name.endsWith("/HEAD")) continue; // symbolic HEAD
    out.push({
      name,
      ref: `${prefix}/${name}`,
      sha,
      commitUnix: Number(unix) || 0,
      isHead: headMarker === "*",
    });
  }
  return out;
}

export function remoteNameOf(refName) {
  return refName.split("/", 1)[0];
}

/** Base refs a branch may have been merged into (e.g. ["origin/main"]). */
export function defaultBaseRefs(meta) {
  const refs = [];
  // Prefer every remote's default branch.
  for (const [remote, def] of Object.entries(meta.remoteDefault)) {
    if (def) refs.push(`${remote}/${def}`);
  }
  // Fall back to local well-known branches when the repo has no remote.
  if (refs.length === 0) {
    const local = listBranches(meta.root, "heads");
    const known = local.find((b) => b.name === "main" || b.name === "master");
    if (known) refs.push(known.name);
    else if (local.length) refs.push(local.find((b) => b.isHead)?.name);
  }
  return refs.filter(Boolean);
}

/**
 * For a list of base refs, return a Set of branch SHAs whose tip is an
 * ancestor of at least one base ref (i.e. "already merged into the base").
 */
export function mergedShaSet(cwd, baseRefs) {
  const merged = new Set();
  for (const base of baseRefs) {
    const r = git(
      ["for-each-ref", "--merged", base, "refs/heads", "refs/remotes", "--format=%(objectname)"],
      { cwd }
    );
    if (!r.ok) continue;
    for (const sha of r.out.split("\n")) {
      if (sha) merged.add(sha);
    }
  }
  return merged;
}

/** Local branch probe: upstream ref (or null) and whether the remote branch still exists. */
export function upstreamOf(cwd, name) {
  const r = git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${name}@{upstream}`],
    { cwd }
  );
  if (!r.ok) return null; // no upstream configured
  return r.out;
}

export function remoteBranchExists(remoteRefs, name) {
  return remoteRefs.some((b) => b.name === name);
}

/** True when the branch name is a ref that should never be touched. */
export function isRefProtected(name) {
  return name === "HEAD" || name.endsWith("/HEAD");
}
