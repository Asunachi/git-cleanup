import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bestPR,
  closePR,
  detectForge,
  loadPRs,
  providerFor,
  providers,
  remoteHost,
  stalePRs,
} from "../src/forge.mjs";

test("remoteHost parses https, ssh and scp-like URLs", () => {
  assert.equal(remoteHost("https://github.com/o/r.git"), "github.com");
  assert.equal(remoteHost("git@github.com:o/r.git"), "github.com");
  assert.equal(remoteHost("ssh://git@gitlab.com/o/r.git"), "gitlab.com");
  assert.equal(remoteHost("https://user@example.com/o/r"), "example.com");
  assert.equal(remoteHost(""), null);
  assert.equal(remoteHost(null), null);
});

test("detectForge classifies hosts; unknown hosts are null", () => {
  assert.equal(detectForge("https://github.com/o/r"), "github");
  assert.equal(detectForge("git@github.com:o/r.git"), "github");
  assert.equal(detectForge("https://gitlab.com/o/r"), "gitlab");
  assert.equal(detectForge("git@gitlab.example.org:o/r.git"), "gitlab"); // self-hosted
  assert.equal(detectForge("https://gitlab.company.net/o/r"), "gitlab");
  assert.equal(detectForge("https://bitbucket.org/o/r"), null);
  assert.equal(detectForge("https://example.com/o/r"), null);
  assert.equal(detectForge(""), null);
});

test("github provider parses its remote URLs and is registered", () => {
  assert.ok(providers.github, "github provider registered");
  const p = providers.github;
  assert.equal(p.id, "github");
  assert.deepEqual(p.parseRemote("https://github.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
  });
  assert.deepEqual(p.parseRemote("git@github.com:owner/repo.git"), {
    owner: "owner",
    repo: "repo",
  });
  assert.equal(p.parseRemote("https://gitlab.com/owner/repo"), null);
  assert.equal(p.parseRemote("https://example.com/owner/repo"), null);
});

test("bestPR picks the newest PR for a branch; stalePRs filters open+old", () => {
  const mk = (number, state, ageDays, headRef) => ({
    number,
    state,
    ageDays,
    headRef,
    updatedAt: "x",
  });
  const map = new Map();
  map.set("feature/a", [mk(1, "closed", 90, "feature/a"), mk(2, "open", 3, "feature/a")]);
  map.set("feature/b", [mk(3, "open", 60, "feature/b")]);
  assert.equal(bestPR(map, "feature/a").number, 1); // newest activity first
  assert.equal(bestPR(map, "missing"), null);
  assert.deepEqual(
    stalePRs(map, 30).map((p) => p.number),
    [3]
  );
});

test("loadPRs degrades gracefully without a supported forge remote", async () => {
  const res = await loadPRs({ cwd: ".", remotes: [], track: true });
  assert.equal(res.source, "none");
  assert.equal(res.provider, null);
  assert.match(res.error, /no supported forge remote found/);
  assert.ok(res.prs instanceof Map);
  const off = await loadPRs({ cwd: ".", remotes: [], track: false });
  assert.equal(off.source, "none");
});

test("providerFor returns null when no remote resolves", () => {
  assert.equal(providerFor(".", []).provider, null);
});

test("closePR rejects unknown providers instead of guessing", async () => {
  await assert.rejects(
    () =>
      closePR({ provider: "gitlab", owner: "o", repo: "r", source: "api", pr: {}, comment: "" }),
    /no forge provider for "gitlab"/
  );
});
