---
description: Show what limitcast warned about and saved since install
allowed-tools: Bash(npx -y --package=https://github.com/SamStull9007/limitcast/releases/download/v0.16.0/limitcast-0.16.0.tgz limitcast results *)
---
Show this limitcast output to the user as-is, then add at most one line of advice. If it says limitcast isn't installed or has no readings yet, tell the user to run `npm install -g https://github.com/SamStull9007/limitcast/releases/download/v0.16.0/limitcast-0.16.0.tgz`, then `limitcast install` in a terminal and restart Claude Code.

!`npx -y --package=https://github.com/SamStull9007/limitcast/releases/download/v0.16.0/limitcast-0.16.0.tgz limitcast results 2>&1 || true`
