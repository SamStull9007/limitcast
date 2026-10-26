# limitcast

Stretch your Claude Code plan. Every session starts with ~100k tokens of context before you type, re-sent on every turn and to every subagent. limitcast measures what's in it, names what you never use, and stops runaway subagents before they burn the rest of your window.

![limitcast status, trim and results running in a terminal](https://limitcast.dev/demo.gif)

```
$ limitcast trim
Every Claude Code session starts at 102.7k tokens before your first message.

## Measured savings: ~6.2k tokens per session (6% of your starting context)
- Disable 9 MCP servers you haven't used in 14 days (~0.9k): postman, context7, ...
- Hide 66 skills from the model (~5.3k): dataviz, block-kit, ...
```

- **Trim advisor:** measures your latest session's starting context from its transcript (SessionStart hook output, MCP server instructions and tool names, skills, agents, instruction files). Free shows the total and how much of it you haven't used; Pro names each item and what it costs, and `trim --apply` makes the cuts for you (reversible). `trim --codex` does the same for Codex (AGENTS.md, MCP servers).
- **Subagent guard (Pro)** for Claude Code and Codex: blocks a new subagent when that tool's own window is on pace to run out before it resets, and while a Claude window is tight runs new subagents on Sonnet instead of your main model. Free installs get a preview that never acts and shows what it would have done.
- **Subagent receipts and budgets (Pro):** when a subagent finishes you see what it cost: "that Explore subagent used ≈2.1% of your 5-hour window (34 calls)". `limitcast budget subagents 15` holds new subagents once they have used 15% of the current window.
- **Cold-cache warning (Pro):** after a long pause (60 min, `LIMITCAST_CACHE_MINUTES`) the prompt cache has expired and your next message re-sends the whole context as new tokens. limitcast holds that first message once and tells you what it will cost; send it again to go ahead, or `/compact` first.
- **Limit-change alert (Pro):** limitcast re-measures how many tokens move your meter by 1% every day and notifies you when that shifts by 15% or more, so you know when the limit itself changed.
- **Daily allowance (free):** today's even share of each weekly window, so you can pace the week: `7d 41% · today 6% left`.
- **Pro extras:** desktop notifications (`limitcast notify on`), also to your phone (`notify ntfy <topic>`) or a Slack/Discord webhook (`notify webhook <url>`), run a job after the reset (`limitcast after-reset -- …`), a pointer to your other account when this one is near its limit, a `/compact` nudge in long sessions, and an HTML dashboard (`limitcast results --html`).
- **Results:** `limitcast results` shows the value since you installed it (tokens not re-sent, limits it warned you about and how far ahead, subagents stopped), then checks the last week against what actually happened.
- **Burn report (Pro):** Claude Code, Codex and Grok tokens by day, project, model and session.
- **Runout forecast (free):** burn rate and the clock time each window runs out.
- **Local only.** Reads the limit readings Claude Code passes to your status line and the logs Claude Code, Codex and Grok already write. No logins, and your usage data never leaves your machine. The free tier makes no network calls; a Pro license key talks to Polar only to activate, to re-check weekly, and to deactivate (it sends the key and your computer's name). If you turn on phone or webhook notifications (Pro, off by default), each notification's text goes to the service you chose (ntfy.sh or your webhook) and nothing else.

| | Claude Code | Codex | Grok |
|---|---|---|---|
| Limit forecast (`status`) | ✓ status-line feed | ✓ session logs | no: Grok keeps no limit readings on disk |
| Subagent guard | ✓ `Task`/`Agent` | ✓ `spawn_agent` | never blocks (nothing to judge by) |
| Token report (`report`) | ✓ | ✓ | ✓ per-turn ledger |
| Trim advisor (`trim`) | ✓ | - | - |

Requires Node 20+ on macOS or Linux.

## Install

```sh
npm install -g limitcast     # or: brew trust samstull9007/limitcast && brew install samstull9007/limitcast/limitcast
limitcast install            # free: status-line recorder
limitcast trial              # Pro free for 7 days, no card (or: limitcast activate <key>)
limitcast install --guard    # also the subagent guard (free: preview only)
limitcast doctor
```

In Claude Code you can also add the plugin, for `/limitcast:status`, `/limitcast:results` and `/limitcast:trim`: `/plugin marketplace add SamStull9007/limitcast`, then `/plugin install limitcast@limitcast`. The status-line recorder still comes from `limitcast install`.

`install` backs up `~/.claude/settings.json` and wraps your existing status line: it looks exactly the same, and the limitcast line (for example `limitcast: 5h 14% · 7d 18% · today 9% left`) goes on the line under it. `--guard` adds the subagent guard (without Pro it only records what it would block). Restart Claude Code to load it. `limitcast uninstall` puts everything back.

**Codex:** forecasts and reports need no setup (`~/.codex/sessions`, or `$CODEX_HOME/sessions`). With `--guard`, `install` also appends the guard to `~/.codex/hooks.json`, after your existing hooks so the ones you've already trusted keep their trust. Codex runs a new hook only once you approve it: start Codex and accept it. `limitcast doctor` shows whether it's trusted.

**Grok:** `report` reads each session's `~/.grok/sessions/*/*/usage.json`. Grok also loads hooks from `~/.claude/settings.json`; the guard's `Task|Agent` matcher doesn't match Grok's `spawn_subagent`, and the guard never blocks Grok spawns anyway.

## Commands

| Command | |
|---|---|
| `limitcast status [--json]` | Used, burn rate, runout time and reset for each window, and today's share of each weekly one. **Pro** also lists your other Claude accounts |
| `limitcast trim --codex [--apply / --undo]` | Codex: AGENTS.md size and MCP servers in `~/.codex/config.toml` you haven't used. **Pro** names them and turns them off (`enabled = false`; `--undo` restores the file exactly) |
| `limitcast notify on/off/test` | **Pro.** A desktop notification when a Claude window turns NEAR, AT_RISK or HIT, and when it resets after a HIT. On macOS they come from a tiny limitcast notifier app, listed as "limitcast" in System Settings → Notifications |
| `limitcast notify ntfy <topic or https URL>` / `notify webhook <https URL>` | **Pro.** Also send every notification to your phone through [ntfy](https://ntfy.sh) (install the app, subscribe to the topic) or to a Slack or Discord incoming webhook. `off` removes it. Sent in the background, so no hook waits on the network |
| `limitcast budget subagents <percent>` / `off` | **Pro.** Once subagents have used that share of the current 5-hour window, the guard holds new ones until it resets. Priced from your own readings (needs about a day of use first) |
| `limitcast after-reset [--src claude/codex] [--window 5h/7d] [--detach] -- <cmd>` | **Pro.** Wait for the window to reset, then run the command |
| `limitcast results --html [--out FILE]` | **Pro.** Results, current windows and the burn report on one page, opened in your browser |
| `limitcast install [--guard] [--alerts]` / `uninstall` | Wire into Claude Code / restore your settings |
| `limitcast doctor [--fix]` | Check the setup, data freshness, license, and that Claude Code, Codex and Grok logs are still in a format limitcast reads. Also runs daily in the background and flags problems in the status line. `--fix` re-installs with the current Node (after a Node upgrade) |
| `limitcast trial` | Pro free for 7 days on this computer, no card, once |
| `limitcast report [--days N] [--out FILE]` | **Pro.** Tokens by tool, day, project, model and session; subagent share |
| `limitcast report --why [--days N]` | **Pro.** Where your new tokens went: subagents, session starts, cache rebuilds after idle, tool results by tool, model output, and the largest single steps (Claude Code only) |
| `limitcast trim [--days N] [--share]` | Measured starting context of your latest session and how much you haven't used in N days (default 7). **Pro** names each item. `--share`: totals only, no names, safe to post |
| `limitcast saved` | **Pro.** How much the part of your starting context you control has dropped since limitcast first measured it, times your sessions since |
| `limitcast trim --apply` / `--undo` | **Pro.** Hide the unused skills from the model and turn off the unused MCP servers for that project, through Claude Code's own settings. Backed up; `--undo` reverses exactly what it changed |
| `limitcast results [--days N] [--share]` | Proof it works: each limit window that reached 100% and how far ahead limitcast warned, and what the guard blocked (free: what it would have blocked) and whether that window then ran out. **Pro** adds starting-context savings. `--share`: totals only |
| `install --alerts` | **Pro.** A SessionStart hook that tells you (never the model) when your starting context grew ~1k+ tokens, and what grew, plus a one-line weekly summary of what limitcast did |
| `limitcast activate <key>` | Unlock Pro: registers this computer with Polar (3 computers per key). Polar re-checks it weekly in the background; it keeps working up to 30 days offline |
| `limitcast deactivate` | Free this computer so the key can be used on another one |
| `limitcast license` | Show the license and re-check it with Polar now |

### Subagent guard (Pro)

Without a valid license the guard runs as a preview: it allows everything and records what it would have blocked (`limitcast results` shows it), so an expired license never blocks your work. Blocks a new subagent only when the spawning tool's window is on pace to run out before it resets, within 30 minutes (`LIMITCAST_GUARD_MINUTES`). A window already at 100% is left to Claude Code, so extra usage keeps working. `LIMITCAST_ALLOW=1` overrides. If the guard itself fails, it allows the call.

`install --guard` also adds two more hooks. A SubagentStop hook prices each finished subagent from its own transcript and, with Pro, shows you the receipt (never the model); `limitcast budget` and `results` use the same record. A UserPromptSubmit hook holds the first message after the prompt cache expired, once per pause, when the session re-sends 100k+ tokens; messages from background agents and `/compact` or `/clear` are never held. Installed `--guard` before 0.11? Run `limitcast doctor --fix` to add them.

## How the forecast works

Each limit reading is saved to `~/.local/state/limitcast/samples.jsonl` when it changes (kept 8 days). The burn rate is the least-squares slope of percent used over the last hour of the current window, and the runout time is where that line reaches 100%. Windows of a day or more (the weekly one) use the average pace over the last full day, idle time included, unless the last hour's pace runs them out within the hour. **AT_RISK** means that happens before the reset; **NEAR** means 95% or more is used. Claude sessions of the same account share one history (matched by window reset times, and usage that only rises), so two accounts used in parallel never mix.

## Pricing

Free: runout forecast with NEAR warnings and the daily allowance, status-line readout, your starting-context total with how much you never use (Claude Code and Codex), `results`, and a preview of the guard. Pro ($79/year or $9/month, 14 days free; or `limitcast trial` for 7 days, no card; Team $69/seat/year, 3 seats minimum): names what to cut and cuts it (`trim --apply`, also for Codex), a subagent guard that blocks and switches to Sonnet, subagent receipts and budgets, the cold-cache warning, limit-change alerts, burn report, alerts, a weekly summary, notifications (desktop, phone or webhook), after-reset jobs, account headroom, the `/compact` nudge and the HTML dashboard. Cancel anytime; 14-day refund on any charge: email support@limitcast.dev. See https://limitcast.dev.

## License

[Elastic License 2.0](LICENSE): free to use; you may not remove or circumvent the license-key checks or offer limitcast as a hosted service.
