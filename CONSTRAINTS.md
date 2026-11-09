# Repository constraints

Implementation contract reviewed by Codex, 2026-11-08. Owner: Limitcast maintainers. This adds checks and grants no exceptions to existing checks.

## Floor

- No secrets, private operator data, new suppressions, unfinished stubs, or silently skipped/deleted tests.
- Preserve existing CLI behavior unless a documented opt-in enables a change.
- Do not weaken checks to get a change through.
- Hooks fail open; ambiguous configuration changes fail closed.

## Enforced

| Rule | Command | When | Verdict |
| --- | --- | --- | --- |
| Existing and new behavior passes; baseline was 234 tests, with one machine-dependent launcher fixture repaired in this change | `node --test` | Task end and CI | Block |
| Repository lint and formatting pass without new suppressions | `npx --yes @biomejs/biome@2.6.3 ci .` | Task end and CI | Block |
| Public content and privacy checks pass, including newly staged files | `node --test test/public-content.test.mjs` | Before commit | Block |
| Optimizer concurrency, safety and lifecycle regressions pass | `node --test test/optimize.test.mjs` | Task end | Block |

## Measured, not promised

Loop replay decisions are checked with `scripts/optimizer-eval.yaml`. They do not establish real-model task success, subscription savings, or comparative superiority. Package smoke checks run in an isolated home; live host hooks need separate approval and verification before being called active.

No exceptions or lowered thresholds are authorized.
