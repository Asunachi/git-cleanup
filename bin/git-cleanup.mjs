#!/usr/bin/env node
// git-cleanup — prune stale/merged Git branches with PR-aware decisions.
import { main } from "../src/cli.mjs";

process.exitCode = await main();
