# limitcast

Stretch your Claude Code plan. Every session starts with ~100k tokens of context before you type, re-sent on every turn and to every subagent. limitcast measures what's in it, names what you never use, and stops runaway subagents before they burn the rest of your window.

```
$ limitcast trim
Every Claude Code session starts at 102.7k tokens before your first message.

## Measured savings: ~6.2k tokens per session (6% of your starting context)
- Disable 9 MCP servers you haven't used in 14 days (~0.9k): postman, context7, ...
- Hide 66 skills from the model (~5.3k): dataviz, block-kit, ...
```

- **Trim advisor (Pro):** measures your latest session's starting context from its transcript (SessionStart hook output, MCP server instructions and tool names, skills, agents, instruction files) and names what you haven't used, with what each costs.
- **Subagent guard (Pro)** for Claude Code and Codex: blocks a new subagent when that tool's own window is on pace to run out before it resets.
- **Burn report (Pro):** Claude Code, Codex and Grok tokens by day, project, model and session.
- **Runout forecast (free):** burn rate and the clock time each window runs out.
- **Local only.** Reads the limit readings Claude Code passes to your status line and the logs Claude Code, Codex and Grok already write. No API calls, no logins, nothing leaves your machine.

| | Claude Code | Codex | Grok |
|---|---|---|---|
| Limit forecast (`status`) | ✓ status-line feed | ✓ session logs | no: Grok keeps no limit readings on disk |
| Subagent guard | ✓ `Task`/`Agent` | ✓ `spawn_agent` | never blocks (nothing to judge by) |
| Token report (`report`) | ✓ | ✓ | ✓ per-turn ledger |
| Trim advisor (`trim`) | ✓ | - | - |

Requires Node 20+ on macOS or Linux.

## Install

```sh
npm install -g limitcast
limitcast install            # free: status-line recorder
limitcast activate <key>     # Pro
limitcast install --guard    # Pro: also the subagent guard
limitcast doctor
```

`install` backs up `~/.claude/settings.json` and wraps your existing status line (it looks exactly the same). With Pro, `--guard` adds the subagent guard. Restart Claude Code to load it. `limitcast uninstall` puts everything back.

**Codex:** forecasts and reports need no setup (`~/.codex/sessions`, or `$CODEX_HOME/sessions`). With `--guard`, `install` also appends the guard to `~/.codex/hooks.json`, after your existing hooks so the ones you've already trusted keep their trust. Codex runs a new hook only once you approve it: start Codex and accept it. `limitcast doctor` shows whether it's trusted.

**Grok:** `report` reads each session's `~/.grok/sessions/*/*/usage.json`. Grok also loads hooks from `~/.claude/settings.json`; the guard's `Task|Agent` matcher doesn't match Grok's `spawn_subagent`, and the guard never blocks Grok spawns anyway.

## Commands

| Command | |
|---|---|
| `limitcast status [--json]` | Used, burn rate, runout time and reset for each window |
| `limitcast install [--guard] [--alerts]` / `uninstall` | Wire into Claude Code / restore your settings |
| `limitcast doctor` | Check the setup, data freshness, license, and that Claude Code, Codex and Grok logs are still in a format limitcast reads |
| `limitcast report [--days N] [--out FILE]` | **Pro.** Tokens by tool, day, project, model and session; subagent share |
| `limitcast trim [--days N] [--share]` | **Pro.** Measured starting context of your latest session and what you haven't used in N days (default 7). `--share`: totals only, no names, safe to post |
| `limitcast saved` | **Pro.** How much the part of your starting context you control has dropped since limitcast first measured it, times your sessions since |
| `install --alerts` | **Pro.** A SessionStart hook that tells you (never the model) when your starting context grew ~1k+ tokens, and what grew |
| `limitcast activate <key>` | Unlock Pro (checked offline) |

### Subagent guard (Pro)

Without a valid license the guard allows everything, so an expired license never blocks your work. Blocks a new subagent only when the spawning tool's window is on pace to run out before it resets, within 30 minutes (`LIMITCAST_GUARD_MINUTES`). A window already at 100% is left to Claude Code, so extra usage keeps working. `LIMITCAST_ALLOW=1` overrides. If the guard itself fails, it allows the call.

## How the forecast works

Each limit reading is saved to `~/.local/state/limitcast/samples.jsonl` when it changes (kept 8 days). The burn rate is the least-squares slope of percent used over the last hour of the current window, and the runout time is where that line reaches 100%. **AT_RISK** means that happens before the reset. Each Claude session is forecast from its own readings, so two accounts used in parallel never mix.

## Pricing

Free: runout forecast and status-line readout. Pro ($79/year, or $149 lifetime for the first 100 buyers): trim advisor, subagent guard, burn report. See https://limitcast.dev.

## License

[Elastic License 2.0](LICENSE): free to use; you may not remove or circumvent the license-key checks or offer limitcast as a hosted service.
