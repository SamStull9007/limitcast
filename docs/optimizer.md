# Repository optimizer

The optimizer complements Limitcast's forecasts, budgets, MCP trimming and subagent controls. It adds local failure-loop detection, evidence-backed check-command learning, built-in capability pruning and a bounded source map. It is opt-in and adds no model or network calls.

```sh
limitcast install --optimize
limitcast optimize status
```

Restart the host. Codex asks you to review and trust the new hooks. Claude Code, Codex and Grok have adapters; other agents are not integrated yet. These commands operate on the current Git repository, including when run from a subdirectory. Worktrees have separate evidence. `LIMITCAST_ALLOW=1` bypasses optimizer hooks. `limitcast uninstall` removes them while preserving unrelated hooks; it does not erase evidence or undo explicit capability edits.

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

Only a small whitelist of test/build/check commands is eligible. Raw prompts, output and arbitrary instructions are not retained or injected. At most four active facts and 1,000 characters are injected per session. This is deliberately narrower than model-synthesized repository knowledge: there is no paid proposer or judge. Inspect the facts and retire any that no longer apply; they are evidence, not commands that Limitcast executes.

## Built-in capabilities

```sh
limitcast optimize capabilities --codex
limitcast optimize keep image_media,collaboration
limitcast optimize capabilities --codex --apply goals
limitcast optimize capabilities --codex --undo
```

Preview is read-only. Five observed sessions and ten prompts are required. Any observed use or a keep-list entry protects a capability. On Codex the candidates are `collaboration`, `goals` and `image_media`; the CLI must expose supported feature controls, and a post-write check must confirm the requested setting is actually disabled. Untrusted projects that ignore the file fail that check and roll back. Host-side or administrator policy may still determine the final tool surface.

For Claude, omit `--codex`. The optimizer reads bounded tool-name declarations from the session transcript at Stop/SessionEnd; a tool needs five declared-but-unused sessions before it is proposed. Missing declarations yield no proposal. Core reading, editing, shell, search, questions, web and skill tools are protected. Existing MCP trim remains available separately for all three original hosts. Grok has no built-in capability-pruning implementation.

Applying a named proposal is explicit, not automatic. Tracked files, symlinks, unsupported controls and explicit conflicting settings are refused. A write-ahead receipt supports recovery after an interrupted apply. Undo restores the exact original bytes only while the resulting file still matches; subsequent user edits cause a refusal rather than data loss. Restored items are protected from later proposals. A capability file created in a repository is local configuration: review it before committing any configuration changes.

## Source map

```sh
limitcast optimize map
limitcast optimize map on
limitcast optimize map off
limitcast optimize map --refresh
```

Maps use tracked source filenames and recognizable declaration names, with a 6,000-character default budget. Reads are bounded to 1,000 candidate files, 100 KB per file and 2 MB in total. Hidden, credential-shaped, generated/vendor paths and symlinks are excluded. A clean tree reuses its commit-keyed cache; a dirty tree regenerates it. The extractor recognizes common declarations, not every language construct, and ranks by source location and declaration count rather than a full dependency graph. No dependency or model call is needed.

Injection starts off. Once enabled, new Claude/Codex sessions receive the cached/generated map at start; Grok receives it with its first tool result. Maps add recurring context, so use them where reduced searching justifies their size.

## Evidence and replay

```sh
limitcast optimize replay /path/to/hooks.json --codex
```

The file is an array of native hook payloads. Replay is in memory and reports redirects, notices, command facts and emitted context; it does not edit repository settings or invent token savings. The deterministic six-case suite in `scripts/optimizer-eval.yaml` covers looping, productive work, changing failures, exploration, duplicate delivery and ambiguous status. No external tools or model calls are attached.

Optimizer state is local under Limitcast's state directory, separated by a hash of repository path and host. It contains bounded counters, command shapes, failure digests and receipts. Explicit capability edits also retain their original configuration bytes locally for undo; protect the state directory like other local configuration. Corrupt or oversized state is preserved and refused rather than silently reset.
