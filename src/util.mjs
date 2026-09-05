// Small shared helpers: date math, terminal colors, and re-exports of the
// glob matcher (which lives in ./engine.mjs so the playground page can bundle
// the exact same code).

export { globToRegExp, matchesAny } from "./engine.mjs";

/** Error for forge problems (unknown forge, missing token, API failure). */
export class ForgeError extends Error {}

const DAY_SECONDS = 24 * 60 * 60;

/** Whole days between two unix timestamps (>= 0). */
export function daysBetween(nowSec, thenSec) {
  const d = Math.floor((nowSec - thenSec) / DAY_SECONDS);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function daysFromNowIso(iso, now = new Date()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / (DAY_SECONDS * 1000)));
}

// Forge API calls must never hang the caller indefinitely (a shell hook, a
// cron job, a CI step) on a dead network: every provider fetch goes through
// this helper, which aborts after GIT_CLEANUP_FETCH_TIMEOUT_MS (default 15s)
// and surfaces the abort as a normal PR lookup error. Read per call so the
// knob also works when exported mid-session and tests can shrink it.
export function fetchWithTimeout(url, init = {}) {
  const ms = Number(process.env.GIT_CLEANUP_FETCH_TIMEOUT_MS || 15000);
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(ms),
  });
}

/**
 * Forge API call that fails loudly with the forge's name on any non-2xx — a
 * broken report job is never silently skipped. `label` is the human forge
 * name used in the error ("GitHub", "GitLab", ...).
 */
export async function apiFetch(url, init, label) {
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new ForgeError(`${label} API ${res.status}: ${detail}`);
  }
  return res;
}

/** "2 branches" / "1 branch" style text for a count of `singular`. */
export function plural(n, singular) {
  if (n === 1) return `1 ${singular}`;
  let word = singular;
  if (/(s|x|z|ch|sh)$/.test(word)) word += "es";
  else if (/[^aeiou]y$/.test(word)) word = word.slice(0, -1) + "ies";
  else word += "s";
  return `${n} ${word}`;
}

// ---- terminal colors -------------------------------------------------------

const useColor =
  !process.env.NO_COLOR &&
  !process.env.GIT_CLEANUP_NO_COLOR &&
  Boolean(process.stdout?.isTTY);

export function color(code, s) {
  return useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export const c = {
  red: (s) => color("31", s),
  green: (s) => color("32", s),
  yellow: (s) => color("33", s),
  bold: (s) => color("1", s),
  dim: (s) => color("2", s),
};
