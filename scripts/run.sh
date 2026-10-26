#!/bin/sh
# Run a limitcast script with the newest nvm Node (survives Node upgrades), or node from PATH.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
N=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
exec "${N:-node}" "$@"
