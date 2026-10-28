# Changelog

## Unreleased

- New: `limitcast grok-usage on` shows Grok's real weekly % used. Grok keeps no % on disk, so limitcast asks grok.com for your billing cycle (the request Grok Build makes) with the login in `~/.grok/auth.json`, about every 5 minutes. It is off by default because it is the one place limitcast uses a login: the login is read in memory, sent only to grok.com (redirects refused) and never stored or logged. The readings feed `status`, the Grok status line, the guard and `doctor`, and a weekly dollar cap steps aside for them. `limitcast grok-usage off` stops it. Weekly plans only; a monthly credit plan is reported but not forecast.

## 0.16.0 — 2026-10-27

- New: `limitcast memory [dir]` checks this project's auto-memory folder: how much of `MEMORY.md` fits in what Claude Code loads every session (the first 200 lines or 25 KB), broken links, topic files nothing links to, and files over 150 lines. `limitcast doctor` shows the same as one line and fails it only when the index is past the cap.
- New plugin commands: `/limitcast:memory-audit` (stale, broken, unlinked and contradictory notes; proposes fixes, changes nothing until you agree) and `/limitcast:memory-split` (an oversized memory file into a short hub plus topic files, after you approve the boundary).

## 0.15.0 — 2026-10-27

- All features are now free and open source under the MIT License, copyright Sam Stull.
- Removed subscription/trial requirements and runtime billing-service checks. Existing activation commands are harmless compatibility messages; old local license files are left untouched.
- Previously installed preview guards now enforce forecasts and enabled budgets; `LIMITCAST_ALLOW=1` remains the override.
- Guards, model controls, budgets, trimming, alerts, notifications and dashboards work without a key. Controls remain opt-in, with existing keep-lists, undo and overrides.
- Added guided read-only onboarding, accurate weekly capacity reporting, private share totals and local pilot measurement.


## Unreleased

- Read-only `limitcast onboard` guides setup, personal findings, trial choices, restarts and safe controls without changing settings.
- `results`, its local dashboard and voluntary share output separate provider usage, estimated context reduction, protection events and free previews. Weekly context estimates use main-thread call timestamps, including sessions crossing the boundary; legacy state remains readable and is rescanned when available.
- Hook records accept host operation IDs so reporting can deduplicate repeated decisions. Missing IDs stay explicitly labeled attempts. Existing guard decisions, overrides and entitlement checks are preserved.
- Savings/trim labels state the character-count/baseline estimate. Previous-period comparisons require complete history; no model/cache/block savings are invented. Added a local consent-based pilot metrics tool and market/retention protocol.

## 0.14.0

- New: `limitcast trim keep <name>[,<name>]` lists servers and skills that `trim --apply` never turns off or hides (Claude, Codex and Grok), for example `limitcast trim keep ego-browser`. `trim` shows what it would keep, and `--remove <name>` drops one.
- New (Pro): the `today N% left` pace of a weekly window now acts. You get one notification a day at 80% of today's share, and `limitcast budget today on` makes the guard hold new subagents once today's share is used up, until local midnight. It is off by default, a window already at 100% is left to the tool, and `LIMITCAST_ALLOW=1` overrides it. Free installs see what Pro would have held in `results`.
- `limitcast status` now says which window runs out first and where else there is room, for example "You'll hit Claude 7d first (Thu 14:00). Grok 5h still has $38."

## 0.13.1

- **Fix:** the advice at the end of `limitcast report --jobs` told you to launch a job with `--setting-sources "" --strict-mcp-config`, which also drops the claude.ai connectors, so a job that reads from HubSpot or Slack would stop working. It now leads with `--settings '{"disableAllHooks": true}'` (hooks off, connectors kept; about 16k new tokens down to about 5k per start in one test) and says plainly that the harder flags drop the connectors.

- **Grok API-equivalent cost.** `limitcast report` prices Grok models at xAI list prices (docs.x.ai, 2026-10-26): grok-4.7 / 4.6 / 4.5 / 4.3 / 4.20 and grok-build-0.1, including the 200k-prompt long-context rate. Cache creation is billed as input (xAI lists cached reads, not a write multiplier). `grok-4.6-build` matches `grok-4.6`. Unknown models stay uncounted.
- **Grok `subagent-model`.** `limitcast subagent-model explore grok-4.3` accepts grok ids, matches types case-insensitively, and writes `[subagents.models]` in `~/.grok/config.toml` (restart Grok). The guard rewrites `spawn_subagent` only when the spawn already has a `model` field: adding one fails Grok's schema and would deny the call.

## 0.13.0

- New (Pro): `limitcast plan` says whether your Claude plan fits how much you use. It keeps a record of the peak of every 5-hour and weekly window (so it needs a week or two of history before it recommends anything), then points to the next plan with the monthly price difference if you reached a limit three or more times (or the weekly limit once), or to a smaller plan if its limits would have held your busiest windows with room to spare. It also shows what your Claude Code tokens would cost at API list prices. Set your plan with `limitcast plan set pro|max5|max20`.

- New (Pro): `limitcast report` shows the API-equivalent cost of your tokens: a total line, and a dollar column by tool, day, project, model and session. It prices input, 5-minute and 1-hour cache writes, cache reads and output at the API's list prices for Claude 5.x models (Haiku is priced higher above 100k-token prompts); any other model is left out and counted as "not counted", never as $0. Add or change prices in `~/.local/state/limitcast/prices.json`.
- New (Pro): `limitcast subagent-model <type> <model>` runs every new subagent of that type on the model you choose, for example `limitcast subagent-model Explore haiku`. A spawn that names its own model is left alone. While a window is tight, a type pinned to Opus is still moved to Sonnet. `limitcast subagent-model` lists what is pinned and the types you ran in the last 30 days, and `results` counts the subagents it moved (free installs see what it would have done).

## 0.12.0

- **Grok status line, trim and guard.** `limitcast install` wraps `[ui.status_line]` in `~/.grok/config.toml`. `--guard` writes `~/.grok/hooks/limitcast.json` for `spawn_subagent`. `limitcast trim --grok` measures the system prompt and unused MCP servers (`--apply` / `--undo` like Codex). Grok stores spend, not a % used: the status line shows `grok 5h $X · 7d $Y` from `usage.json`; `limitcast budget grok <usd>` (Pro) turns that into a forecast the guard can block on.
- `limitcast report --why` now splits subagent tokens by type and model and shows all new tokens by model. A subagent's type comes from the `.meta.json` file next to its transcript. Models may count differently against your limit, so these are token counts, not window shares.
- `limitcast report --jobs` adds a cold-starts column per job and a "Cold starts" section: how many runs started without the prompt cache, how much more that cost than the same job's warm runs, and whether starting a job's runs closer together would help.

- New (Pro): `limitcast report --jobs` lists the scheduled (headless) jobs whose runs spend the most new tokens just starting. Runs of one job are grouped by the first 45 characters of their prompt, with runs, average new tokens at start, average starting prompt, share of all new tokens and calls per run, plus how to launch a job leaner. `report --why` points to it when there are headless runs.

- New (Pro, `install --alerts`): a PostToolUse hook tells you, once per tool per session, when a single tool result is very large (about 20k tokens or more, from its size; `LIMITCAST_TOOL_TOKENS` changes the threshold), with what to ask for next time. It runs on Bash, Read, Grep, WebFetch and MCP tools, shows the message to you only, and adds about 30 ms per call. Re-run `limitcast install --alerts` (or `doctor --fix`) to add it to an existing install.
- `limitcast report --why` ends with "What to try": how many single steps added over 20k new tokens and what share of tool-result tokens they were, and advice for the sources whose results average 2k+ new tokens.

- New (Pro, with the guard): before a subagent starts you see what that kind has cost you, e.g. "Explore subagents have cost you a median ≈1.2% (max ≈3.6%) of a 5-hour window over 7 runs; this window is 38% used". It appears once there are 3 priced runs, uses all your subagents when that kind has fewer, and stays quiet when a typical run is under 1% of a window and the window is not NEAR. It never blocks.
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
