---
description: Show what limitcast warned about and saved since install
allowed-tools: Bash(npx -y limitcast@0.15.0 results *)
---
Show this limitcast output to the user as-is, then add at most one line of advice. If it says limitcast isn't installed or has no readings yet, tell the user to run `npx limitcast install` in a terminal and restart Claude Code.

!`npx -y limitcast@0.15.0 results 2>&1 || true`
