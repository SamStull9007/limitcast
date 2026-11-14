# Repository optimizer

The optimizer complements Limitcast's forecasts, budgets, MCP trimming and subagent controls. It adds local failure-loop detection, evidence-backed check-command learning, built-in capability pruning and a bounded source map. It is opt-in. Its deterministic mode adds no model/network calls; optional model work consumes your Codex plan.

```sh
limitcast install --optimize
limitcast optimize status
```

Restart the host. Codex asks you to review and trust the new hooks. Claude Code, Codex, Grok, Copilot CLI and Pi have optimizer adapters. These commands operate on the current Git repository, including when run from a subdirectory. Worktrees have separate evidence. `LIMITCAST_ALLOW=1` bypasses optimizer hooks. `limitcast uninstall` removes them while preserving unrelated hooks; it does not erase evidence or undo explicit capability edits.

## Failure loops

The hook tracks edits, explicit failing results and repeated failure signatures within a prompt-turn. It redirects only after a sustained repeated-failure segment, and uses the repository's productive turn lengths once five are available. Passing a recognized check clears earlier failure evidence. Read-only exploration, long productive work and changing errors alone do not trigger it. A later notice reports continued repetition after the redirect. It never terminates the turn or a running command.

Events with tool-call IDs are deduplicated. Events without IDs are attempts; delivery cannot be proven unique. State retains at most 30 session details per host and 1,000 completed-session IDs. Old evidence outside that window can be observed again. Hooks skip subagent payloads that identify themselves. Unknown or ambiguous exit status is not treated as success. Detection is heuristic; replay tests do not prove that a real model will follow the redirect.

## Learn check commands

```sh
limitcast optimize learn on
limitcast optimize learn
limitcast optimize forget <fact-id>
limitcast optimize learn off
```

Learning starts off. A recognized check command must fail because its executable/module is missing, and an alternative must then succeed. Three independent sessions must confirm that replacement before it is injected. A later missing-command/module result for the replacement retires the fact. Ordinary test assertion failures do not teach environment facts.

Replacements must preserve the check: Python launcher variants for the same pytest or unittest runner, and `npm test`/`npm run test`, are equivalent. Build, lint, type-check and unrelated test runners are not interchangeable. Previously saved incompatible replacements are excluded from injected context.

Only a small whitelist of test/build/check commands is eligible. Raw prompts, output and arbitrary instructions are not retained or injected. At most four active facts and 1,000 characters are injected per session. The deterministic mode learns command alternatives. Optional model learning also selects successful verification commands; arbitrary repository prose is intentionally excluded. Inspect the facts and retire any that no longer apply; they are evidence, not commands that Limitcast executes.

## Built-in capabilities and MCP servers

```sh
limitcast optimize capabilities --codex
limitcast optimize keep image_media,collaboration
limitcast optimize capabilities --codex --apply goals
limitcast optimize capabilities --grok --apply some-server
limitcast optimize capabilities --codex --undo
```

Preview is read-only. Five observed sessions and ten prompts are required. Any observed use or a keep-list entry protects a capability. On Codex the candidates are `collaboration`, `goals` and `image_media`, plus every MCP server in your Codex `config.toml` that no session in this repository has called. On Grok the candidates are the MCP servers in your Grok `config.toml` that no session in this repository has called; Grok has no persistent setting that removes a built-in tool, so there are no built-in candidates.

Applying a server writes `[mcp_servers.<name>]` with `enabled = false` to the project's `.codex/config.toml` or `.grok/config.toml`. Your user-level definition stays untouched. Codex merges the project table into it, so the table holds only `enabled`. Grok replaces the server with the project's entry whole and ignores one without a command, so the table also holds `command = "true"`, a stub that never runs because the server is off; nothing of your own definition (arguments, tokens, headers) is copied into the repository. The host must expose supported controls, and a post-write check (`codex features list`, `codex mcp list --json`, `grok mcp list --json`) must confirm the requested setting is actually off. A host that ignores the file fails that check and rolls back. Host-side or administrator policy may still determine the final tool surface.

In your home directory the "project" file is your own user config, so `--apply` refuses there and points to `limitcast trim --codex --apply` / `limitcast trim --grok --apply`, which turn servers off in your user config for every project (backed up, `--undo` reverses it). Checked with the real CLIs: Codex 0.169 honors the project table in a trusted project, and a headless Grok 1.0.77 session does not start a server that a project stub disables. An interactive Grok session honors project config once you trust the folder.

For Claude, omit `--codex`. The optimizer reads bounded tool-name declarations from the session transcript at Stop/SessionEnd; a tool needs five declared-but-unused sessions before it is proposed. The tool catalog holds up to 400 tools per repository. Missing declarations yield no proposal. Core reading, editing, shell, search, questions, web and skill tools are protected. Existing MCP trim remains available separately for all three original hosts; it works across all your sessions, while these proposals look only at the current repository.

Applying a named proposal is explicit, not automatic. Tracked files, symlinks, unsupported controls and explicit conflicting settings are refused. A write-ahead receipt supports recovery after an interrupted apply. Undo restores the exact original bytes only while the resulting file still matches; subsequent user edits cause a refusal rather than data loss. Restored items are protected from later proposals. A capability file created in a repository is local configuration: review it before committing any configuration changes.

## Source map

```sh
limitcast optimize map
limitcast optimize map on
limitcast optimize map off
limitcast optimize map --refresh
```

Maps use tracked source filenames and recognizable declaration names, with a 6,000-character default budget. Reads are bounded to 1,000 candidate files, 100 KB per file and 2 MB in total. Hidden, credential-shaped, generated/vendor paths and symlinks are excluded. A clean tree reuses its commit-keyed cache; a dirty tree regenerates the map without replacing that clean cache. Legacy caches are regenerated once. The extractor recognizes common declarations, not every language construct, and ranks by source location and declaration count rather than a full dependency graph. No dependency or model call is needed.

Injection starts off. Once enabled, new Claude/Codex sessions receive the cached/generated map at start; Grok receives it with its first tool result. Maps add recurring context, so use them where reduced searching justifies their size.

## Evidence and replay

```sh
limitcast optimize replay /path/to/hooks.json --codex
```

The file is an array of native hook payloads. Replay is in memory and reports redirects, notices, command facts and emitted context; it does not edit repository settings or invent token savings. The deterministic six-case suite in `scripts/optimizer-eval.yaml` covers looping, productive work, changing failures, exploration, duplicate delivery and ambiguous status. No external tools or model calls are attached.

Optimizer state is local under Limitcast's state directory, separated by a hash of repository path and host. It contains bounded counters, command shapes, failure digests and receipts. Explicit capability edits also retain their original configuration bytes locally for undo; protect the state directory like other local configuration. Corrupt or oversized state is preserved and refused rather than silently reset.


## Optional model learning and judging

```sh
limitcast optimize model on
limitcast optimize learn on
limitcast optimize model
limitcast optimize model off
```

Requires an authenticated Codex CLI supporting `--ignore-user-config` (verified on 0.167.0). All five host adapters use this same Codex backend; Copilot/Pi provider accounts are not used for optimizer calls. Native gpt-5.6-luna calls use low reasoning, a neutral temporary directory, an ephemeral read-only session, no user config/rules/project documents, disabled hooks/plugins/shell/collaboration/web, and a structured output schema. Missing/unsupported native features fail open with an error receipt; an unavailable model is not silently replaced.

Only allowlisted check commands, action types, counts and hashed file/failure identities are sent. There are no raw transcripts, source text, prompts or tool output. The learning model selects commands observed passing, requires three independent session confirmations, and retires a selected check when it later fails. Facts cannot become arbitrary model-authored instructions. This narrower learning surface does not reproduce TokenEconomizer's general prose repository facts.

Judging runs after the heuristic detects a suspicious loop. A redirect requires stuck=true and confidence at least 0.7, is delivered on a later tool-result event, and never stops work. Results from a different prompt-turn, ended/productive session or expired job are discarded. Unknown verdicts/errors do not authorize a redirect. A productive verdict remains valid for at most twelve more calls or five minutes.

Model work runs in a detached process outside the state lock. One outstanding job and six attempts in a rolling 24 hours are allowed per repository across hosts. Each native call times out after 45 seconds; leases expire after two minutes. The status receipt records actual input/cached/output usage when reported; missing usage is null, not zero. Native base prompts can cost thousands of tokens. Calls do not guarantee net savings. Disable model work to cancel pending application; deterministic learning and controls remain usable.

## Copilot CLI and Pi

```sh
limitcast optimize install --copilot
limitcast optimize install --pi
# Remove the corresponding adapter:
limitcast optimize install --copilot --undo
limitcast optimize install --pi --undo
```

Restart the selected host. Copilot installation owns only `~/.copilot/hooks/limitcast.json` (or COPILOT_HOME) and uses the documented PascalCase payloads and top-level additionalContext. Pi adds the packaged extension path to `~/.pi/agent/settings.json` (or PI_CODING_AGENT_DIR), preserving other extensions. Both installers back up existing settings and refuse symlinks or conflicting files. They do not install or authenticate an agent. Use a stable global Limitcast installation before installing adapters; moving/removing that installation requires reinstalling them. General `limitcast uninstall` covers the original three hosts; use the explicit adapter --undo commands for Copilot/Pi.

Host contracts: [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference), [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). Copilot/Pi optimizer support does not add their allowance forecasting or built-in capability pruning.
