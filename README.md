# limitcast

Know when Claude Code and Codex will hit their usage limits before they do, stop new subagents when you're about to run out, and see where your tokens go.

```
$ limitcast status
window     used  burn      runs out  resets     status
claude 5h  71%   +24.0%/h  17:52     18:40      AT_RISK
claude 7d  48%   +1.1%/h   -         Tue 09:00  OK
codex 7d   10%   +0.5%/h   -         Fri 12:41  OK
```

- **Local only.** Reads the limit readings Claude Code passes to your status line and the logs Claude Code and Codex already write. No API calls, no logins, nothing leaves your machine.
- **Runout forecast** per limit window: burn rate, the time you'll run out, and whether that's before the reset.
- **Subagent guard:** a PreToolUse hook that blocks new subagents when a Claude window is on pace to run out before it resets.
- **Pro:** a weekly burn report and a trim advisor for the context every session loads before you type.

Requires Node 20+ on macOS or Linux.

## Install

```sh
npm install -g limitcast
limitcast install --guard
limitcast doctor
```

`install` backs up `~/.claude/settings.json`, wraps your existing status line (it looks exactly the same), and with `--guard` adds the subagent guard. Restart Claude Code to load it. `limitcast uninstall` puts everything back.

Codex needs no setup: `limitcast status` reads `~/.codex/sessions` (or `$CODEX_HOME/sessions`).

## Commands

| Command | |
|---|---|
| `limitcast status [--json]` | Used, burn rate, runout time and reset for each window |
| `limitcast install [--guard]` / `uninstall` | Wire into Claude Code / restore your settings |
| `limitcast doctor` | Check the setup, data freshness and license |
| `limitcast report [--days N] [--out FILE]` | **Pro.** Tokens by tool, day, project, model and session; subagent share |
| `limitcast trim [--days N]` | **Pro.** Fixed context per interactive session and what to cut |
| `limitcast activate <key>` | Unlock Pro (checked offline) |

### Subagent guard

Blocks a new subagent only when a Claude window is on pace to run out before it resets, within 30 minutes (`LIMITCAST_GUARD_MINUTES`). A window already at 100% is left to Claude Code, so extra usage keeps working. `LIMITCAST_ALLOW=1` overrides. If the guard itself fails, it allows the call.

## How the forecast works

Each limit reading is saved to `~/.local/state/limitcast/samples.jsonl` when it changes (kept 8 days). The burn rate is the least-squares slope of percent used over the last hour of the current window, and the runout time is where that line reaches 100%. **AT_RISK** means that happens before the reset. Each Claude session is forecast from its own readings, so two accounts used in parallel never mix.

## Pricing

Free: status, guard, status-line readout. Pro: $79/year, or $149 lifetime for the first 100 buyers. See https://limitcast.dev.

## License

[Elastic License 2.0](LICENSE): free to use; you may not remove or circumvent the license-key checks or offer limitcast as a hosted service.
