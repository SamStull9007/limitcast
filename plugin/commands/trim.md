---
description: Measure your starting context and what you never use (limitcast)
allowed-tools: Bash(npx -y limitcast@0.14.0 trim *)
---
Show this limitcast output to the user as-is, then add at most one line of advice. If it says limitcast isn't installed or has no readings yet, tell the user to run `npx limitcast install` in a terminal and restart Claude Code.

!`npx -y limitcast@0.14.0 trim 2>&1 || true`
