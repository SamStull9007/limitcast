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
| Production-only coverage holds the measured repair baseline (95.12% lines, 82.03% branches, 91.53% functions on Node 24/macOS; integer floors 95/82/91) | `node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-include='bin/**' --test-coverage-lines=95 --test-coverage-branches=82 --test-coverage-functions=91` | Task end on Node 24/macOS; replaces the plain test invocation only in that existing CI matrix cell | Block |
| Repository lint and formatting pass without new suppressions | `npx --yes @biomejs/biome@2.6.3 ci .` | Task end and CI | Block |
| Public content and privacy checks pass, including newly staged files | `node --test test/public-content.test.mjs` | Before commit | Block |
| Optimizer concurrency, safety and lifecycle regressions pass | `node --test test/optimize.test.mjs` | Task end | Block |
| Packed CLI works without the source checkout or operator configuration | `node scripts/package-smoke.mjs` | Task end and CI on Node 22/24/26, macOS/Linux | Block |
| Zero ERROR-level findings from Semgrep's focused `p/ci` ruleset in production Python, JavaScript and TypeScript under `src/`, `bin/` and `scripts/` | `pre-commit run semgrep-security --all-files` | Automatically on matching staged files before a local commit; all-files at rollout | Block on findings, scanner failure or unavailable rules |

## Local Semgrep commit check

Added 2026-11-12 under Sam's authorized Semgrep rollout. Install with `uv tool install --python 3.12 semgrep`, install `pre-commit`, then run `pre-commit install` in this checkout. The hook is installed on Sam's Mac; another clone or machine needs that setup separately. CI also runs the focused scan with pinned Semgrep 1.185.0. It reuses the installed Semgrep executable locally and preserves the existing test/lint commands. There is no background service, platform login or source upload; telemetry and version checks are disabled. Rules are fetched from the Semgrep Registry, so rule-service availability is required at commit time and in CI. The upstream pack can change; new findings require review rather than automatic suppression. Diagnostics omit matched source text.

The rollout baseline was zero ERROR-level findings across 44 production files (10 applicable rules), using Semgrep 1.185.0. Test fixtures, dependencies, vendored code, other paths and languages are outside this gate. Broad audit rules remain advisory. No exceptions are added.

## Measured, not promised

Loop replay decisions are checked with `scripts/optimizer-eval.yaml`. They do not establish real-model task success, subscription savings, or comparative superiority. Package smoke checks run in an isolated home; live host hooks need separate approval and verification before being called active.

No exceptions or lowered thresholds are authorized.

Coverage scope and floors were added under Sam's 2026-11-16 audit-repair authorization. Other Node/OS matrix cells retain the complete test suite and packed-artifact checks. Review this contract with its CI change; the aggregate intentionally excludes test code, generated fixtures and packed copies. A failing floor requires better tests or implementation review, not automatic threshold reduction.
