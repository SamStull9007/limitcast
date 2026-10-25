# limitcast

Know when Claude Code and Codex will hit their usage limits, before they do, and stop spawning new subagents when you're about to.

```
$ limitcast status
window     used  burn      runs out  resets     status
claude 5h  71%   +24.0%/h  17:52     18:40      AT_RISK
claude 7d  48%   +1.1%/h   -         Tue 09:00  OK
codex 7d   10%   +0.5%/h   -         Fri 12:41  OK
```

- **Reads only what your tools already write locally.** Claude Code's status-line feed and Codex's session logs. No API calls, no logins, no tokens leave your machine.
- **Burn rate and runout time** per limit window (Claude 5-hour and weekly, Codex windows).
- **Subagent guard:** a PreToolUse hook that blocks new subagents when a Claude limit is on pace to run out before it resets.

Requires Node 20+.

## Install

```sh
npm install -g limitcast
```

### Claude Code: record limits from the status line

Wrap your existing status-line command in `~/.claude/settings.json`. Your status line looks exactly the same:

```json
"statusLine": {
  "type": "command",
  "command": "limitcast statusline -- bash ~/.claude/your-statusline.sh"
}
```

No status line yet? Use `"command": "limitcast statusline"` for a compact `5h 71% ⚠ out 17:52` readout.

### Claude Code: guard subagents (optional)

```json
"hooks": {
  "PreToolUse": [
    { "matcher": "Task|Agent", "hooks": [{ "type": "command", "command": "limitcast guard" }] }
  ]
}
```

The guard blocks a new subagent only when a Claude window is used up, or on pace to run out before it resets within 30 minutes (`LIMITCAST_GUARD_MINUTES`). Set `LIMITCAST_ALLOW=1` to override. If anything goes wrong it allows the call: it never stops your agent by mistake.

### Codex

Nothing to set up. `limitcast status` reads `~/.codex/sessions` (or `$CODEX_HOME/sessions`).

## How the forecast works

Each limit reading is saved to `~/.local/state/limitcast/samples.jsonl` (only when it changes; kept 8 days). The burn rate is the least-squares slope of percent-used over the last hour of the current window. The runout time is when that line reaches 100%. **AT_RISK** means that happens before the window resets.

## License

MIT
