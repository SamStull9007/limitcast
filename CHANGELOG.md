# Changelog

## 0.2.0

- `install` / `uninstall` / `doctor`: one-command setup with settings backup, idempotent re-install, and exact restore of your original status line.
- Pro: `report` (tokens by tool, day, project, model and session; subagent share) and `trim` (fixed context per interactive session and what loads it).
- Offline Ed25519 license keys (`activate`, `license`).
- Each Claude session is forecast from its own readings, so parallel accounts never mix.
- The guard no longer blocks windows already at 100%, so extra usage keeps working.
- License changed to Elastic License 2.0.

## 0.1.0

- `status` runout forecast for Claude Code and Codex, `statusline` recorder, `guard` subagent hook.
