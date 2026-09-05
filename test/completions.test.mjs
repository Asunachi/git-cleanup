// The `completions` subcommand prints the shipped bash/zsh/fish completion
// scripts; --help advertises it, and bad shell names fail loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";

const origWrite = process.stdout.write;
const origErr = console.error;

/** Run main() capturing stdout/stderr; returns { code, out, err }. */
async function run(args) {
  const out = [];
  const err = [];
  // Capturing the stream (not console.log) catches process.stdout.write too,
  // which is what the completions subcommand uses.
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

test("completions bash/zsh/fish print the shipped scripts", async () => {
  const cases = [
    ["bash", /# bash completion for git-cleanup/, /complete -F _git_cleanup git-cleanup/],
    ["zsh", /#compdef git-cleanup/, /compadd -a commands/],
    ["fish", /# fish completion for git-cleanup/, /complete -c git-cleanup/],
  ];
  for (const [shell, head, body] of cases) {
    const { code, out } = await run(["completions", shell]);
    assert.equal(code, 0, `${shell}: exit code`);
    assert.match(out, head, `${shell}: header`);
    assert.match(out, body, `${shell}: content`);
  }
});

test("--help advertises the completions subcommand", async () => {
  const { code, out } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /completions/);
});

test("completions with an unknown or missing shell fails loudly", async () => {
  const bad = await run(["completions", "powershell"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err.join("\n"), /powershell/);
  assert.match(bad.err.join("\n"), /bash, zsh, fish/);

  const none = await run(["completions"]);
  assert.equal(none.code, 1);
  assert.match(none.err.join("\n"), /completions needs one shell argument/);
});
