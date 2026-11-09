# Optimizer comparison — 2026-11-09

Compared Limitcast 0.19.0 development source with [TokenEconomizer 264e7a7](https://github.com/microsoft/TokenEconomizer/tree/264e7a7f32f0112a06aa83a97b9c2c4681563968). This is bounded evidence, not a claim of overall superiority or financial savings.

## Real model component comparison

Run `node scripts/compare-optimizer.mjs <pinned-upstream-checkout> <report.json>`. Both products received the same six synthetic process summaries through Codex 0.167.0 / gpt-5.6-luna / low reasoning. Calls used neutral directories, disabled tools/hooks/plugins and ignored user configuration. TokenEconomizer supplied its actual judge prompt; Limitcast supplied its actual worker prompt and output schema. This deliberately isolates judgment from the products' different full-session integrations.

| Case | Limitcast | TokenEconomizer |
| --- | --- | --- |
| Repeated dead end | Correct | Correct |
| Productive checks | Correct | Correct |
| Changing failure signatures | Incorrect: stuck | Incorrect: stuck |
| Read-only exploration | Correct | Correct |
| Recovery after failure | Correct | Correct |
| Insufficient evidence | Correct | Correct |

Both scored 5/6. Limitcast's heuristic prevents the changing-signature case from reaching its judge; TokenEconomizer's native gate opens at eight errors even without repeats. This is a measured guard difference on the supplied summary, not an end-to-end coding result. More permissive gating can also catch cases Limitcast misses.

Across the six valid calls: Limitcast reported 120,028 input / 31,744 cached-input / 497 output tokens in 30.642 seconds. TokenEconomizer reported 120,485 input / 42,240 cached-input / 270 output tokens in 28.180 seconds. Cached tokens are a subset of input. These totals do not show a net cost or latency win for Limitcast. Subscription pricing was not inferred.

An initial exploration fixture accidentally included failed test calls. Both products marked it stuck. Those two results were excluded; the corrected exploration fixture was rerun for both. Other first-run results were retained. One sample per valid case, no significance claim. The harness does not install TokenEconomizer or run external write tools.

## Robustness checks

Limitcast rejects a non-boolean stuck value. Calling upstream's actual `llm_stuck_judge` with a synthetic reply containing `"stuck":"false"` produced stuck=true through Python truthiness; Limitcast's regression test refuses that reply. Limitcast also requires typed confidence, rejects unobserved/model-invented commands, requires three independent confirmations, discards expired/different-turn verdicts, and preserves null usage when missing.

A separate native detached-worker check completed three real learning calls, promoted `node --test`, injected it into a fresh session, and completed a judge call whose redirect arrived on the next tool result. Actual native usage was retained. The Pi 1.5.0 native loader loaded the packaged extension with all five event handlers and no errors. Adapter regression tests verify settings preservation and uninstall. These checks do not establish a signed-in Copilot/Pi coding session.

## Remaining differences

Limitcast keeps forecasting, pacing, subagent budgets and receipts alongside the optimizer. Its model learning is deliberately limited to successful verification commands and deterministic command alternatives. TokenEconomizer can synthesize more general repository prose, uses host-native model backends, and supports additional agents. Limitcast's optional worker currently requires Codex for every host. Its source map uses a bounded dependency-free declaration extractor rather than Aider's ranked dependency map.

Overall superiority and real-world token savings remain unproven. The release adds tested safeguards and the requested adapters while making these boundaries explicit.
