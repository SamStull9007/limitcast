# Changelog

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
