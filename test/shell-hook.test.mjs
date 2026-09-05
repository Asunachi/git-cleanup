// The `shell-hook` subcommand prints the shipped shell/git hook snippets;
// --help advertises it, and bad kinds fail loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";

const origWrite = process.stdout.write;
const origErr = console.error;

/** Run main() capturing stdout/stderr; returns { code, out, err }. */
async function run(args) {
  const out = [];
  const err = [];
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  console.error = (...a) => err.push(a.map(String).join(" "));
  let code;
  try {
    code = await main(args);
  } finally {
    process.stdout.write = origWrite;
    console.error = origErr;
  }
  return { code, out: out.join(""), err };
}

test("shell-hook bash/zsh/fish/pre-commit print the shipped snippets", async () => {
  const cases = [
    ["bash", /git-cleanup shell integration for bash and zsh/, /__git_cleanup_maybe_scan/],
    ["zsh", /git-cleanup shell integration for bash and zsh/, /chpwd_functions/],
    ["fish", /git-cleanup shell integration for fish/, /--on-variable PWD/],
    ["pre-commit", /pre-commit hook/, /commits are never blocked/],
  ];
  for (const [kind, head, body] of cases) {
    const { code, out } = await run(["shell-hook", kind]);
    assert.equal(code, 0, `${kind}: exit code`);
    assert.match(out, head, `${kind}: header`);
    assert.match(out, body, `${kind}: content`);
  }
});

test("shell hooks only ever run the summary scan — never a destructive invocation", async () => {
  const bash = (await run(["shell-hook", "bash"])).out;
  const fish = (await run(["shell-hook", "fish"])).out;
  const hook = (await run(["shell-hook", "pre-commit"])).out;
  for (const [name, text] of [["bash", bash], ["fish", fish], ["pre-commit", hook]]) {
    assert.match(text, /scan --summary/, `${name}: hooks run the summary scan`);
    // Deleting requires a flag (--yes, --remote, -d/-D, --close); advice text
    // like "run git-cleanup prune" stays allowed, destructive invocations don't.
    for (const forbidden of [
      "prune --yes",
      "prune -y",
      "--remote",
      "branch -d",
      "branch -D",
      "push --delete",
      "--close",
    ]) {
      assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name}: must not contain ${forbidden}`);
    }
  }
});

test("--help advertises the shell-hook subcommand and --summary", async () => {
  const { code, out } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /shell-hook/);
  assert.match(out, /--summary/);
});

test("shell-hook with an unknown or missing kind fails loudly", async () => {
  const bad = await run(["shell-hook", "powershell"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err.join("\n"), /powershell/);
  assert.match(bad.err.join("\n"), /bash, zsh, fish, pre-commit/);

  const none = await run(["shell-hook"]);
  assert.equal(none.code, 1);
  assert.match(none.err.join("\n"), /shell-hook needs one argument/);
});
