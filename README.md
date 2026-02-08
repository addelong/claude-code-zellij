# claude-code-zellij

Add [Zellij](https://zellij.dev/) terminal multiplexer support to [Claude Code](https://github.com/anthropics/claude-code) agent teams.

Claude Code's agent teams feature automatically splits teammate agents into separate terminal panes. By default, this only works with tmux and iTerm2. This patch adds native Zellij support so each agent gets its own Zellij pane.

## Requirements

- **Claude Code v2.1.34** installed via **npm** (see [Supported install methods](#supported-install-methods) below)
- [Zellij](https://zellij.dev/) 0.40.0+
- Node.js 18+

## Supported install methods

This patch works by modifying Claude Code's bundled `cli.js` file. It is only compatible with the **npm-installed** version of Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
```

The following install methods produce a compiled binary that **cannot be patched**:

| Install method | Binary type | Patchable? |
|---|---|---|
| `npm install -g @anthropic-ai/claude-code` | JavaScript (`cli.js`) | Yes |
| `brew install claude-code` (Homebrew cask) | ELF/Mach-O binary | No |
| `curl -fsSL https://claude.ai/install.sh \| sh` | ELF binary | No |

If you installed Claude Code via the curl script or Homebrew cask, you'll need to also install it via npm for the patch to work. The patcher will automatically find and patch the npm installation.

### Version compatibility

The patcher dynamically extracts minified variable names from `cli.js` using regex, so it survives minor version bumps where only the mangled names change. Tested with v2.1.34 and v2.1.36.

If a future version changes the code structure (not just variable names), the patch may fail. Use the `check` command to verify compatibility before installing:

```bash
node dist/src/index.js check
```

The check output will show exactly which patches can or cannot be applied.

## Install

```bash
git clone https://github.com/addelong/claude-code-zellij.git
cd claude-code-zellij
npm install
npm run build
```

### Apply the patch

The patcher automatically finds your Claude Code npm installation:

```bash
node dist/src/index.js install
```

Or specify the path to `cli.js` explicitly:

```bash
node dist/src/index.js install /path/to/claude-code/cli.js
```

A backup (`cli.js.bak`) is created automatically so you can revert at any time.

### Verify

```bash
node dist/src/index.js check
```

### Uninstall

Restores the original `cli.js` from the backup created during install:

```bash
node dist/src/index.js uninstall
```

### Re-patching after Claude Code updates

When Claude Code updates itself, the patched `cli.js` gets overwritten. You'll need to re-apply the patch:

```bash
cd claude-code-zellij
node dist/src/index.js install
```

If the new version changed the minified variable names, the install will fail and tell you which anchors need updating.

## Usage

1. Start a Zellij session: `zellij`
2. Set the agent teams env var: `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
3. Run Claude Code: `claude`
4. Ask Claude to use agent teams (e.g., "spawn a teammate to work on the tests")

Each teammate agent will appear in its own Zellij pane.

## How it works

Claude Code has a backend registry system where terminal multiplexer backends implement a common interface for pane management. This patch injects a `ZellijBackend` class into the bundled `cli.js` that uses Zellij's CLI actions:

- **Pane creation**: `zellij action new-pane --name <agent-name>` creates a named pane and auto-focuses it
- **Command injection**: `zellij action write-chars` + `zellij action write 13` types the agent startup command into the newly focused pane
- **Serialization lock**: Ensures only one pane is created at a time, preventing focus race conditions when spawning multiple agents

The patch modifies Claude Code's backend detection cascade to check for Zellij:

1. Inside tmux? -> Use tmux backend
2. Inside iTerm2? -> Use iTerm2 backend
3. **Inside Zellij? -> Use Zellij backend** (new)
4. tmux available externally? -> Use tmux backend
5. **Zellij available externally? -> Use Zellij backend** (new)
6. Error

### Architecture

```
src/
  ZellijBackend.ts      # Reference TypeScript implementation of the backend
  zellijDetection.ts    # Environment detection (ZELLIJ env vars)
  patchCli.ts           # Anchor-based string replacement patcher for cli.js
  index.ts              # CLI entry point (install/uninstall/check)
```

The patcher uses anchor strings from the minified `cli.js` to find insertion points. If Claude Code updates and the anchor strings change, the patcher will report exactly which patches failed so you know what to update.

## Limitations

These are inherent to Zellij's current CLI (v0.43.0):

| Feature | tmux | Zellij | Impact |
|---------|------|--------|--------|
| Per-pane border colors | Yes | No | Agent panes won't have colored borders |
| Layout rebalancing | Yes | No | Zellij auto-layouts, but can't be commanded |
| Kill pane by ID | Yes | No | Agent processes exit naturally on completion |
| Hide/show panes | Yes | No | Not available |
| Target pane by ID for writes | Yes | No | Uses focus-based approach instead |

The focus-based write approach means there is a brief window (~200ms) between pane creation and command injection where manually switching Zellij focus could cause issues. In practice this is not a problem since the operations happen near-instantly and a serialization lock prevents concurrent pane creation.

## Compatibility

Tested with:
- Claude Code v2.1.34, v2.1.36 (npm install)
- Zellij 0.43.0
- Linux (Ubuntu 24.04)

## License

MIT
