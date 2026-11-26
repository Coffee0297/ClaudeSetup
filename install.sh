#!/usr/bin/env bash
# claude-setup for macOS / Linux / cloud sessions.  ./install.sh [--dry-run] [--no-plugins] [--no-bypass]
set -e
command -v node >/dev/null || { echo "Node.js is required (the hooks run on it)"; exit 1; }
node "$(cd "$(dirname "$0")" && pwd)/install.js" "$@"
