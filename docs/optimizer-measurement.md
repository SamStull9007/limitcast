# Measuring optimizer effectiveness

The deterministic six-case replay in `scripts/optimizer-eval.yaml` checks intervention decisions. It cannot establish task success or net savings. Keep these separate from packed-adapter smoke tests and configuration checks.

For a bounded first live comparison, use three synthetic repository tasks: repair one failing test, implement one small requested behavior, and investigate a changing failure without editing. Give each an explicit outcome check, the same starting commit and instructions, and a fixed maximum duration/token budget. Run optimizer off and on in fresh equivalent workspaces, three repeats each, sequentially: 18 task runs. This is a protocol, not an automated model invocation; obtain the run budget before starting. Missing cost estimates remain unknown.

Use the same host, model and reasoning settings in both configurations. Keep installed tools and non-Limitcast hooks constant. “Off” means the optimizer hook is absent from the disposable host configuration; “on” enables only the optimizer features being evaluated. Never toggle the operator's live configuration for an experiment. If learned facts are part of the comparison, use identical recorded training evidence and report its preparation cost separately.

For every run record:

| Field | Measurement |
| --- | --- |
| Task outcome | Independent task check pass/fail and any changed files outside scope |
| Usage | Actual input, cached-input and output tokens from the task and optimizer model receipts; unknown fields stay null |
| Overhead | Injected context estimates, optimizer model calls and their actual usage; avoid counting worker usage twice in host totals |
| Time | Wall-clock duration, timeouts and hook latency |
| Interventions | Redirects/notices and whether each matched a repeated dead end, productive work or changing investigation |
| Provenance | Code SHA, fixture, host/model versions, exact configuration, repeat and run order |

Alternate the order of off/on pairs. Compare success first, then token categories and elapsed time among successful matched tasks. Report medians, ranges and all failures; exclude no run just because it contradicts the expected benefit. Keep cached and fresh tokens separate, and do not equate API list-price estimates with subscription savings.

Retain private run artifacts locally outside Git. Publish only reviewed synthetic fixtures and aggregate results. Do not claim a general improvement from this small sample; report the exact tasks, configurations and uncertainty. No live comparison results accompany this protocol.
