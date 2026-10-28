# limitcast plugin

In a terminal:

```
claude plugin install limitcast --marketplace SamStull9007/limitcast
```

Or inside Claude Code: `/plugin marketplace add SamStull9007/limitcast`, then `/plugin install limitcast@limitcast`.

Slash commands for [limitcast](https://limitcast.dev), which forecasts when your Claude Code usage limits run out, measures the starting context every session re-sends, and stops runaway subagents before they burn the rest of your window.

- `/limitcast:status`: used, burn rate, runout time and reset for each window, and today's share of each weekly one.
- `/limitcast:results`: what limitcast warned you about and saved since you installed it.
- `/limitcast:trim`: your starting context and how much of it you never use.

The commands run `npx limitcast` locally; nothing leaves your machine. Limit readings come from the status line, so also run `npx limitcast install` once in a terminal and restart Claude Code. Requires Node 20+ on macOS or Linux.

## What it changes on your machine

The slash commands only read. They change nothing.

`limitcast install`, which you run yourself in a terminal, edits Claude Code's settings:

- `~/.claude/settings.json`: wraps your status line so it also records limit readings (your status line looks the same), and with `--guard` or `--alerts` adds a PreToolUse hook (the subagent guard) and a SessionStart hook (starting-context alerts). The file is backed up first.
- `~/.codex/hooks.json`, with `--guard`: appends the Codex subagent guard after your existing hooks. Codex asks you to approve it.
- `~/.grok/config.toml` and `~/.grok/hooks/limitcast.json`: wraps the Grok status line; `--guard` matches `spawn_subagent`. Grok spend becomes a forecast after `limitcast budget grok <usd>`.
- `limitcast trim --apply` hides unused skills from the model (`skillOverrides` in `~/.claude/settings.json`; `/name` still works) and turns off unused MCP servers for a project (`disabledMcpServers` in `~/.claude.json`, the list the `/mcp` toggle writes). Both files are backed up, and `limitcast trim --undo` reverses exactly what it changed.

`limitcast uninstall` restores your original settings. limitcast's own state lives in `~/.local/state/limitcast/`.
