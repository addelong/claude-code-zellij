#!/usr/bin/env bash
set -euo pipefail

# claude-code-zellij uninstaller
# Restores original Claude Code cli.js from backup

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "claude-code-zellij uninstaller"
echo "==============================="
echo ""

if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
    echo "Error: Patcher not built. Run 'npm run build' first."
    exit 1
fi

if [ -n "${1:-}" ]; then
    node "$PROJECT_DIR/dist/index.js" uninstall "$1"
else
    node "$PROJECT_DIR/dist/index.js" uninstall
fi
