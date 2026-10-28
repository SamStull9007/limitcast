---
description: Show when each Claude Code usage limit runs out (limitcast)
allowed-tools: Bash(npx -y limitcast@0.17.0 status *)
---
Show this limitcast output to the user as-is, then add at most one line of advice. If it says limitcast isn't installed or has no readings yet, tell the user to run `npm install -g limitcast`, then `limitcast install` in a terminal and restart Claude Code.

!`npx -y limitcast@0.17.0 status 2>&1 || true`
