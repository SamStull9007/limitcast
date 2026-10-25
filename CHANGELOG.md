# Changelog

## 0.8.1

- Weekly (and other multi-day) windows are forecast from the average pace over the last full day, idle time included, instead of the last hour. One busy hour no longer shows a weekly runout days early (`7d 3% ⚠ out Tue`). If the last hour's pace would run the window out within the hour, that still wins, so the guard catches a burst near the end of the week. The 5-hour window is unchanged.

## 0.8.0

- Fix: Claude readings were forecast per session, and a short session rarely has 5 minutes of readings, so the forecast and the guard often had no burn rate. Sessions of the same account (same window reset times, usage only rising) now share one history. On the author's own data this turned a missed 7-day limit into a 40-minute warning.
- New **NEAR** status at 95%+, even before there is a burn rate. The guard still blocks only on AT_RISK.
- `limitcast trim --apply` (Pro): hides the unused skills from the model (`skillOverrides`, `/name` still works) and turns off the unused MCP servers for that project (the same list `/mcp` writes). Backs up both files; `limitcast trim --undo` reverses exactly what it changed. Plugin skills and servers whose exact name it can't confirm are listed for `/plugin` and `/mcp`. `trim` warns if something it turned off still loads.
- Guard preview: without Pro, `install --guard` installs the guard in log-only mode. It never blocks; `limitcast results` shows what Pro would have blocked and whether those windows then ran out.
- Weekly summary (Pro, with `--alerts`): once a week at session start, one line to you (never the model): limits reached, warning lead, subagents blocked, tokens saved.
- `limitcast results --share`: totals only, safe to post.
- `limitcast results` opens with what limitcast did since it started watching, kept beyond the 8 days of raw readings: tokens not re-sent (your smaller starting context times every main-thread model call, read from your transcripts), how many of the limits it watched you approach it warned you about and how far ahead, and the subagents the guard stopped. A daily background rollup, started by the status line, keeps it current.

## 0.7.0

- `limitcast results [--days N]`: each limit window that reached 100% and how far ahead the forecast warned, replayed from your own readings. Pro adds every subagent the guard blocked and whether that window then ran out, plus starting-context savings.
- The guard records each block (time, window, percent, forecast) in `guard.jsonl` so `results` can check it later. Nothing else is logged.

## 0.6.2

- README: Lifetime is $149 once, with no "first 100 buyers" limit. No code changes.

## 0.6.1

- Fix: a Pro license used only through hooks (guard, alerts) was never re-checked with Polar and switched off after 30 days. The status line now starts a detached weekly re-check (at most one attempt an hour) and never waits on the network.
- Free `limitcast trim` shows your measured starting context and how much of it you haven't used (totals, no names); Pro names each item.
- `doctor` no longer calls a Polar subscription "lifetime": it shows when the key was last checked with Polar.
- Clear messages when Polar rate-limits activate or deactivate. `limitcast license` is in the help.
- README states exactly what talks to Polar. Biome lint in CI.

## 0.6.0

- Polar license keys: `limitcast activate LIMITCAST-…` registers this computer with Polar once (3 computers per key), then works offline. Interactive commands re-check weekly; hooks never touch the network. A key keeps working 30 days offline, and stops when Polar says it was revoked, refunded or expired.
- `limitcast deactivate` frees this computer so the key can move to another one.
- Signed offline keys (`LC1.…`) still work.

## 0.5.0

- `install --alerts` (Pro): a SessionStart hook that tells you, as a message the model never sees, when your starting context grew ~1k+ tokens since the last session, naming what grew. Runs in ~0.3 s.
- `limitcast saved` (Pro): how much the part of your starting context you control dropped since limitcast first measured it, times your interactive sessions since.
- `limitcast trim --share`: a summary with totals only (no project, file, skill, server or hook names), safe to post.
- `doctor` now checks that your latest Claude Code, Codex and Grok logs still contain the fields limitcast reads, and says so plainly when a tool changed its format.
- Log-format contract tests with fixtures mirroring the real field names of all three tools.

## 0.4.0

- `trim` measures your latest interactive session's starting context from its transcript: each SessionStart hook's output, MCP server instructions and tool names (per server), the agent list, the skill listing (per skill) and instruction files. "Measured savings" counts the MCP servers and skills you haven't used in the period (Skill calls, slash commands and MCP tool calls in your transcripts), with exact sizes.
- The subagent guard is now Pro. Without a license, `guard` allows everything and `install --guard` installs only the free features.
- Landing page: "stretch your plan" positioning and a comparison with ClaudeBar and ccusage.

## 0.3.0

- Codex subagent guard: `install --guard` appends it to `~/.codex/hooks.json` (existing hooks keep their positions and trust); it judges `spawn_agent` by Codex's own limits from the last two hours of session logs. `doctor` reports whether Codex has trusted it.
- The guard now judges each tool only by its own limits; Grok's `spawn_subagent` is never blocked (Grok keeps no limit readings on disk).
- `report` includes Grok, read from each session's per-turn `usage.json` ledger.
- Fix: Codex sessions were grouped into one row in `report`.
- Fix: readings recorded before 0.2's session tagging no longer mix into forecasts (caused a false AT_RISK).

## 0.2.0

- `install` / `uninstall` / `doctor`: one-command setup with settings backup, idempotent re-install, and exact restore of your original status line.
- Pro: `report` (tokens by tool, day, project, model and session; subagent share) and `trim` (fixed context per interactive session and what loads it).
- Offline Ed25519 license keys (`activate`, `license`).
- Each Claude session is forecast from its own readings, so parallel accounts never mix.
- The guard no longer blocks windows already at 100%, so extra usage keeps working.
- License changed to Elastic License 2.0.

## 0.1.0

- `status` runout forecast for Claude Code and Codex, `statusline` recorder, `guard` subagent hook.
