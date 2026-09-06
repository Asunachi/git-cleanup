// Structural test for support/config.schema.json — the editor-facing JSON
// Schema for the layered config. Pinned the same way the workflow tests pin
// CI definitions: if the loader (normalizeConfig) or the defaults grow a key
// the schema does not know — or the forge registry gains a provider the enum
// omits — this fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "../src/classify.mjs";
import { providers } from "../src/forge.mjs";
import { normalizeConfig } from "../src/config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(join(root, "support", "config.schema.json"), "utf8")
);

test("config schema: shape and draft", () => {
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false, "unknown keys are typos — flag them");
  assert.ok(schema.properties, "schema has properties");
  assert.match(schema.$id ?? "", /config\.schema\.json$/);
});

test("config schema: covers every top-level key the loader reads", () => {
  const props = schema.properties;
  for (const key of Object.keys(defaults())) {
    assert.ok(props[key], `schema missing top-level key "${key}" (from defaults)`);
  }
  for (const key of [
    "deleteMergedAfterDays",
    "warnUnmergedAfterDays",
    "pr",
    "remote",
    "backup",
    "forge",
    "sweep",
    "protected",
    "rules",
    "repos",
  ]) {
    assert.ok(props[key], `schema missing top-level key "${key}" (from normalizeConfig)`);
  }
  // The $schema editor hint is ignored by the loader, so it must be allowed.
  assert.equal(props.$schema.type, "string");
});

test("config schema: forge.hosts enum matches the registered providers", () => {
  const hosts = schema.properties.forge.properties.hosts;
  assert.ok(hosts.additionalProperties, "forge.hosts values are constrained");
  assert.deepEqual(
    [...hosts.additionalProperties.enum].sort(),
    Object.keys(providers).sort()
  );
});

test("config schema: mode enums match the loader's accepted values", () => {
  assert.deepEqual(schema.properties.sweep.properties.mode.enum, ["report", "prune"]);
  assert.deepEqual(schema.properties.rules.items.properties.mode.enum, ["merged", "any"]);
  assert.deepEqual(
    schema.properties.repos.items.oneOf[1].properties.mode.enum,
    ["report", "prune"]
  );
});

test("config schema: a kitchen-sink config survives normalizeConfig", () => {
  const cfg = {
    deleteMergedAfterDays: 10,
    warnUnmergedAfterDays: 20,
    pr: { track: false, staleAfterDays: 5, closeStaleAfterDays: 3, closeComment: "bye" },
    remote: { pruneMerged: false, deleteAbandonedAfterDays: 7 },
    backup: { enabled: false, dir: "/tmp/backups", retainDays: 4 },
    forge: { hosts: { "git.example.com": "gitlab" } },
    sweep: { mode: "prune", remote: true, reportFile: "report.md", reportIssue: { title: "t" } },
    protected: ["release/**"],
    rules: [{ match: "feature/*", mode: "any", minAgeDays: 1 }],
    repos: [{ path: "../other", mode: "report" }, "/abs/path"],
  };
  assert.doesNotThrow(() => normalizeConfig(cfg));
});
