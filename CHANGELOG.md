# Changelog

## Unreleased

- New: `limitcast report --why` shows where your new tokens went (subagents, session starts, cache rebuilds after idle, tool results by tool, model output) and the largest single steps. It reads your Claude Code transcripts once and caches them, so only the first run over a few GB is slow (3 to 40 seconds, depending on whether the disk cache is warm) and later runs only read what changed.
- `limitcast report` now ranks projects, models and sessions by new tokens (input, cache writes, output) instead of total tokens, so cached reads no longer decide the order.

## 0.11.5

- The license is the Elastic License 2.0, as in 0.11.3. 0.11.4 was published with the wrong license text and is deprecated; use 0.11.5 or later. No code changes.

## 0.11.3

- If you wrap your own status line, the limitcast line (`5h 14% · 7d 18% · today 9% left`, plus any warning) now always shows on the line under it. Before, it appeared only when there was something to act on, so the runout forecast was invisible to anyone with their own status line.
- A status-line script that prints without a trailing newline no longer gets the limitcast line glued onto its end.

## 0.11.2

- When a Polar license stops working because the subscription ended or the key was revoked, `limitcast license` now says so and links to pricing, instead of "license not found at Polar".

## 0.11.1

- Install docs: Homebrew 7+ refuses formulas from untrusted taps, so the README now says to run `brew trust samstull9007/limitcast` before `brew install`. No code changes.

## 0.11.0

Four new Pro features, each priced from your own measured tokens-per-percent:
- **Cold-cache warning:** after a pause longer than the prompt cache lives (60 min; `LIMITCAST_CACHE_MINUTES`), the next message re-sends the whole context as new tokens. A UserPromptSubmit hook holds that first message once, when the context is 100k+ tokens, and says what it costs ("≈1.5% of your 5-hour window, ≈0.02% if the cache were still warm"). Send it again to go ahead, or `/compact` first. Background-agent reports and `/compact`/`/clear` are never held. Free installs record what it would have held.
- **Subagent receipts and budgets:** a SubagentStop hook shows what each finished subagent cost ("that Explore subagent used ≈2.1% of your 5-hour window (34 calls, 180k new tokens)"). `limitcast budget subagents <percent>` makes the guard hold new subagents once they have used that share of the current window.
- **Limit-change alert:** the daily rollup keeps a 3-day calibration per day and notifies you when the new tokens per 1% of your window moves by 15% or more against the weeks before ("Your Claude limit looks smaller: 1% now takes ~139k new tokens, down from ~167k"). `results` shows it for two weeks.
- **Phone and webhook notifications:** `limitcast notify ntfy <topic>` and `limitcast notify webhook <url>` (Slack and Discord) send every notification there too, by a detached `curl`, so no hook waits on the network. Only the notification text is sent.

Also: `results` has a "Subagents and cold caches" section; the weekly summary and the free weekly hint count cold-cache holds and budget holds. `install --guard` adds the two new hooks and `uninstall` removes them, leaving your own hooks alone; `limitcast doctor` tells Pro users who installed `--guard` before 0.11 to run `limitcast doctor --fix`.

## 0.10.1

- `results`, `trim`, `report`, `saved` and `drift` print headings and highlights in bold in a terminal instead of showing raw Markdown (`##`, `**`). Piped output and `--out` files are still Markdown; `NO_COLOR` gives plain text without the markers.

## 0.10.0

Robustness:
- Hooks go through a small launcher in the state dir (`limitcast-hook.sh`) that survives Node upgrades: if the Node or limitcast it points at moved, it runs `limitcast` from PATH, and if that's gone too, your status line still shows and every hook allows. `limitcast doctor --fix` re-installs with the current Node. (Codex asks you to approve the guard again after a re-install.)
- Daily background health check (the doctor checks): a problem shows `⚠ run limitcast doctor` in the status line, and a notification if they're on.
- `trim --apply` cuts that a running Claude Code session wrote over (all at once) are put back at the next session start. Ones you turn back on yourself are left alone.
- Parsed transcripts are cached: `trim`, `report` and the dashboard read only new or changed ones (41 s → 1 s on a heavy setup).

Value and conversion:
- `results` shows what a smaller starting context was worth against your 5-hour limit, calibrated from your own readings: how many new tokens and how many cached tokens move your meter by 1%.
- `limitcast trial`: Pro for 7 days on this computer, no card.
- Free installs see one line a week in the status line with what Pro would have done (subagents stopped, moved to Sonnet), when there's something to show.
- `install` shows your starting context right away and what `results` will show in a week.
- Team plan: $69 per seat per year (3 seats minimum), each person gets their own key.
- Claude Code plugin marketplace in this repo (`/limitcast:status`, `/limitcast:results`, `/limitcast:trim`) and a Homebrew tap.

## 0.9.2

- macOS notifications come from limitcast's own notifier app (`dev.limitcast.notifier`, no Dock icon, built and ad-hoc signed by `limitcast notify on` with the tools macOS ships), so "limitcast" is listed in System Settings → Notifications and can be allowed there. Before, they came from osascript, attributed to Script Editor, which may not be listed at all. `notify on` also sends a first test notification.

## 0.9.1

- Pricing in the README: Pro is $9/month or $79/year with a 14-day free trial; the Lifetime plan is retired (existing keys keep working). No code changes.

## 0.9.0

Pro now acts on what limitcast sees; free gets the daily allowance and a preview of each action.

- **Daily allowance (free):** weekly windows show today's even share of what's left until the reset, and how much of it today used: `7d 41% · today 6% left` in the status line, a `today` column in `status`.
- **Model guard (Pro):** while a Claude window is NEAR or AT_RISK, a new subagent that would run on the main model (or Opus/Fable) runs on Sonnet instead, through the hook's `updatedInput`. An explicit Sonnet or Haiku is left alone; `LIMITCAST_ALLOW=1` keeps the main model. Free installs record what Pro would have switched. `results` counts the switches.
- **Account headroom (Pro):** `status` lists every other Claude account with current readings; when the current one is NEAR, AT_RISK or at its limit, the status line points to the one with the most room.
- **Long sessions (Pro):** past ~150k tokens re-sent per model call, the status line suggests `/compact`. If you wrap your own status line, Pro adds a second line only when there is something to act on.
- **Desktop notifications (Pro, opt-in):** `limitcast notify on` sends one notification when a Claude window turns NEAR, AT_RISK or HIT, and when it resets after a HIT (macOS, or Linux with notify-send).
- **Run after reset (Pro):** `limitcast after-reset [--src] [--window] [--detach] -- <command>` waits for the reset, then runs the command.
- **Codex trim:** `limitcast trim --codex` shows the AGENTS.md size Codex loads and the MCP servers in `~/.codex/config.toml` you haven't used; Pro names them and `--apply` turns them off with `enabled = false` (backed up; `--undo` restores the file exactly).
- **HTML dashboard (Pro):** `limitcast results --html` writes results, current windows and the burn report to one page and opens it.

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
