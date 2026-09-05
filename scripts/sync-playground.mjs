#!/usr/bin/env node
// Bundles src/engine.mjs into index.html between the __ENGINE_START__ /
// __ENGINE_END__ markers, so the playground runs the exact same decision
// engine as the CLI. Run `npm run sync:playground` after editing engine.mjs;
// test/playground-parity.test.mjs fails CI if the page's bundled copy is
// stale relative to src/engine.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = readFileSync(join(root, "src", "engine.mjs"), "utf8");
const page = readFileSync(join(root, "index.html"), "utf8");

// Strip the module header comment (it references Node-side paths) and any
// `export ` keywords so the code runs as plain top-level declarations inside
// the page's IIFE. Everything from the `glob matching` section onward must
// survive untouched.
const body = engine
  .slice(engine.indexOf("// ---- glob matching"))
  .replace(/^export /gm, "");

const START = "/* __ENGINE_START__ */";
const END = "/* __ENGINE_END__ */";
const startIdx = page.indexOf(START);
const endIdx = page.indexOf(END);
if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
  console.error(
    "index.html is missing the __ENGINE_START__ / __ENGINE_END__ markers —",
    "re-add them around the engine block (see the playground script section)."
  );
  process.exit(1);
}

const out =
  page.slice(0, startIdx + START.length) +
  "\n" +
  body +
  "\n  " +
  END +
  page.slice(endIdx + END.length);
writeFileSync(join(root, "index.html"), out);
console.log(`playground engine synced (${body.split("\n").length} lines from src/engine.mjs)`);