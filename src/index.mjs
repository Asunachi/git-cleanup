// Public API for embedding git-cleanup in other tooling.
export { analyzeRepo } from "./analyze.mjs";
export { classify, classifyRemote, defaults, VERDICTS } from "./classify.mjs";
export { loadConfig, normalizeConfig } from "./config.mjs";
export {
  bestPR,
  closePR,
  findGitHubRemote,
  loadPRs,
  parseGitHubRemote,
  stalePRs,
} from "./github.mjs";
export {
  defaultBaseRefs,
  git,
  listBranches,
  mergedShaSet,
  repoMeta,
  resolveRef,
  upstreamOf,
} from "./git.mjs";
export { pruneRepo, confirmed, interactive } from "./prune.mjs";
export { actionableDelete, countBranches, reposToJSON } from "./report.mjs";
export { globToRegExp, matchesAny } from "./util.mjs";
