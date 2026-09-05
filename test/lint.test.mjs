// The zero-dependency linter runs as part of the test suite, so a commit that
// breaks syntax or formatting can never go green. See scripts/lint.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintAll } from "../scripts/lint.mjs";

test("every JS file in the repo passes the zero-dependency linter", () => {
  const { errors } = lintAll();
  const msg = errors
    .map((e) => `${e.file}:\n  ${e.problems.join("\n  ")}`)
    .join("\n");
  assert.deepEqual(errors, [], msg || "lint should pass");
});
