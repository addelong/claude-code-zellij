import { execFile } from "child_process";
import { isInsideZellijSync, isZellijAvailable } from "./zellijDetection";

const ZELLIJ_BIN = "zellij";
const PANE_INIT_DELAY_MS = 200;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function exec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        code: error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

function debug(msg: string): void {
  if (process.env.DEBUG || process.env.CLAUDE_CODE_DEBUG) {
    console.error(msg);
  }
}

function zellijAction(args: string[]): Promise<ExecResult> {
  return exec(ZELLIJ_BIN, ["action", ...args]);
}

/**
 * Serialization lock to prevent concurrent pane creation races.
 * Same pattern used by TmuxBackend in Claude Code.
 *
 * When multiple agents are spawned, each spawn must complete
 * (create pane + send command) before the next one starts,
 * because write-chars writes to the currently focused pane.
 */
let lockQueue: Promise<void> = Promise.resolve();

function acquireLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = lockQueue;
  lockQueue = next;
  return prev.then(() => release);
}

/**
 * ZellijBackend implements the Claude Code pane backend interface
 * for the Zellij terminal multiplexer.
 *
 * Key design decisions:
 * - Pane creation uses `zellij action new-pane --name <name>` which
 *   creates a new pane and auto-focuses it
 * - Command sending uses `zellij action write-chars` which writes
 *   to the currently focused pane (the just-created one)
 * - A serialization lock ensures only one pane is being created
 *   at a time, preventing focus race conditions
 * - Features unsupported by Zellij CLI (border colors, layout
 *   rebalancing, hide/show) are graceful no-ops
 */
export class ZellijBackend {
  type = "zellij" as const;
  displayName = "Zellij";
  supportsHideShow = false;

  private paneCreationCount = 0;

  async isAvailable(): Promise<boolean> {
    if (isInsideZellijSync()) return true;
    return isZellijAvailable();
  }

  async isRunningInside(): Promise<boolean> {
    return isInsideZellijSync();
  }

  /**
   * Create a new Zellij pane for a teammate agent.
   *
   * Flow:
   * 1. Acquire serialization lock (prevents concurrent pane creation)
   * 2. Create pane with `zellij action new-pane --name <name>`
   * 3. New pane auto-receives focus
   * 4. Return synthetic paneId for tracking
   *
   * The lock is released after sendCommandToPane completes (the lock
   * spans create + send to ensure the focused pane doesn't change).
   */
  async createTeammatePaneInSwarmView(
    name: string,
    color: string
  ): Promise<{ paneId: string; isFirstTeammate: boolean }> {
    const release = await acquireLock();
    // Store release function so sendCommandToPane can call it
    this._pendingRelease = release;

    try {
      const isFirst = this.paneCreationCount === 0;
      this.paneCreationCount++;

      const paneId = `zellij-${name}-${this.paneCreationCount}`;

      const result = await zellijAction([
        "new-pane",
        "--name",
        name,
      ]);

      if (result.code !== 0) {
        release();
        this._pendingRelease = null;
        throw new Error(
          `Failed to create Zellij pane for ${name}: ${result.stderr}`
        );
      }

      debug(
        `[ZellijBackend] Created teammate pane for ${name}: paneId=${paneId}, isFirst=${isFirst}`
      );

      // Brief delay for pane initialization (same as TmuxBackend's 200ms)
      await new Promise((resolve) => setTimeout(resolve, PANE_INIT_DELAY_MS));

      return { paneId, isFirstTeammate: isFirst };
    } catch (err) {
      // Ensure lock is released on error
      if (this._pendingRelease) {
        this._pendingRelease();
        this._pendingRelease = null;
      }
      throw err;
    }
  }

  private _pendingRelease: (() => void) | null = null;

  /**
   * Send a command to a pane by writing to the currently focused pane.
   *
   * This MUST be called immediately after createTeammatePaneInSwarmView
   * while the new pane still has focus. The serialization lock ensures
   * no other pane creation can happen between create and send.
   */
  async sendCommandToPane(
    paneId: string,
    command: string,
    _isExternal: boolean = false
  ): Promise<void> {
    try {
      // Write the command text to the focused pane
      const writeResult = await zellijAction(["write-chars", command]);
      if (writeResult.code !== 0) {
        throw new Error(
          `Failed to write command to Zellij pane ${paneId}: ${writeResult.stderr}`
        );
      }

      // Send Enter key (byte 13 = carriage return)
      const enterResult = await zellijAction(["write", "13"]);
      if (enterResult.code !== 0) {
        throw new Error(
          `Failed to send Enter to Zellij pane ${paneId}: ${enterResult.stderr}`
        );
      }

      debug(`[ZellijBackend] Sent command to pane ${paneId}`);
    } finally {
      // Release the serialization lock now that create+send is complete
      if (this._pendingRelease) {
        this._pendingRelease();
        this._pendingRelease = null;
      }
    }
  }

  /**
   * Zellij does not support per-pane border color customization via CLI.
   */
  async setPaneBorderColor(
    _paneId: string,
    _color: string,
    _isExternal: boolean = false
  ): Promise<void> {
    // No-op: Zellij doesn't support per-pane border colors
  }

  /**
   * Pane name is already set during creation via --name flag.
   */
  async setPaneTitle(
    _paneId: string,
    _name: string,
    _color: string,
    _isExternal: boolean = false
  ): Promise<void> {
    // No-op: name was set at creation time via --name
  }

  /**
   * Zellij always shows pane names in the UI by default.
   */
  async enablePaneBorderStatus(
    _windowTarget?: string,
    _isExternal?: boolean
  ): Promise<void> {
    // No-op: Zellij shows pane borders/names by default
  }

  /**
   * Zellij auto-manages pane layout. No CLI command for rebalancing.
   */
  async rebalancePanes(
    _target: string,
    _isExternal: boolean
  ): Promise<void> {
    debug("[ZellijBackend] rebalancePanes: no-op (Zellij auto-layouts)");
  }

  /**
   * Best-effort pane cleanup.
   *
   * Zellij's close-pane only works on the focused pane and cannot
   * target by ID. The Claude process running in the pane will exit
   * naturally when the agent completes or when its AbortController fires.
   */
  async killPane(
    paneId: string,
    _isExternal: boolean = false
  ): Promise<boolean> {
    debug(`[ZellijBackend] killPane ${paneId}: best-effort (process will exit naturally)`);
    return true;
  }

  /**
   * Not supported in Zellij.
   */
  async hidePane(
    _paneId: string,
    _isExternal: boolean = false
  ): Promise<boolean> {
    return false;
  }

  /**
   * Not supported in Zellij.
   */
  async showPane(
    _paneId: string,
    _target: string,
    _isExternal: boolean = false
  ): Promise<boolean> {
    return false;
  }
}

/**
 * Reset backend state (for testing).
 */
export function resetZellijBackendState(): void {
  lockQueue = Promise.resolve();
}
