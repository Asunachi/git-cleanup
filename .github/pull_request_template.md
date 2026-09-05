## What & why

<!-- One or two sentences: what this changes and the problem it solves. Link
the issue it closes, if any. -->

## Checklist

- [ ] `npm test` passes locally (unit + integration + fuzz + lint)
- [ ] If I touched `src/engine.mjs`, I ran `npm run sync:playground` and
      committed the re-bundled `index.html` (CI enforces this)
- [ ] Behavior changes are documented (README, CHANGELOG `[Unreleased]`)
- [ ] New behavior has a test (and the playground's test-count badge was
      updated if the suite size changed)
- [ ] I did not add any runtime dependencies

## Test plan

<!-- How did you verify this? Paste commands/output that prove it works. -->