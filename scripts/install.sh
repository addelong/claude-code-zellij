#!/usr/bin/env bash
set -euo pipefail

# claude-code-zellij installer
# Patches Claude Code's cli.js to add Zellij terminal multiplexer support

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "claude-code-zellij installer"
echo "============================"
echo ""

# Check if we're in a Zellij session
if [ -z "${ZELLIJ_SESSION_NAME:-}" ]; then
    echo "Warning: Not currently inside a Zellij session."
    echo "The patch will still be applied, but agent teams will only"
    echo "work when Claude Code is run inside Zellij."
    echo ""
fi

# Build if needed
if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
    echo "Building patcher..."
    cd "$PROJECT_DIR"
    npm install 2>/dev/null
    npm run build
    echo ""
fi

# Run the patcher
if [ -n "${1:-}" ]; then
    node "$PROJECT_DIR/dist/index.js" install "$1"
else
    node "$PROJECT_DIR/dist/index.js" install
fi
