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
