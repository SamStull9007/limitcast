# A quick look at Limitcast

[← Overview](../README.md) · [Quick start](../README.md#quick-start) · [Full usage guide](usage.md)

Three ways to make room in your AI coding plan. These illustrations use example data and summarize the CLI's output; they are not live screenshots or promises of savings.

## Forecast your windows

![Example forecast: Claude is 71 percent used and forecast to run out before reset; Codex has room to work.](assets/forecast.svg)

See which usage window is on pace to run out first. The forecast comes from your own readings and recent usage, with daily pacing for weekly windows.

```sh
limitcast status
```

Claude uses status-line readings; Codex reads session logs. Grok requires a dollar budget or opt-in weekly readings. [Forecast method →](usage.md#how-the-forecast-works)

## Give subagents a budget

![Example guard decision: a new spawn is held at 93 percent usage with about 21 minutes to runout. Existing agents continue.](assets/guard.svg)

Enable protection when you want it. A hold prevents a new spawn; it doesn't cancel agents already running. You can override a hold with `LIMITCAST_ALLOW=1`.

```sh
limitcast install --guard
limitcast budget subagents 15
```

Restart your coding tool and approve the Codex hook if prompted. Budgets need calibration from your own readings. [Guard details →](usage.md#subagent-guard)

## Inspect what you load

![Example trim finding: 102.7 thousand starting tokens and 6.2 thousand estimated removable tokens. Inspect first and apply explicitly.](assets/trim.svg)

Find unused starting context before deciding what to change. Keep essential skills and servers, apply cuts explicitly, and undo them when needed.

```sh
limitcast trim
limitcast trim keep <name>
limitcast trim --apply
limitcast trim --undo
```

For other providers, use `trim --codex` or `trim --grok`. Context reductions are estimates against a baseline, not measured financial savings. [Commands and qualifications →](usage.md#commands)

---

**Ready to try it?** [Start here →](../README.md#quick-start)
