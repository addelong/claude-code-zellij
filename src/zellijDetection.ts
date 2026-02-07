import { execFileSync } from "child_process";

/**
 * Check if we're currently running inside a Zellij session.
 * Zellij sets ZELLIJ="0" and ZELLIJ_SESSION_NAME inside sessions.
 */
export function isInsideZellijSync(): boolean {
  return (
    process.env.ZELLIJ === "0" && !!process.env.ZELLIJ_SESSION_NAME
  );
}

/**
 * Async version of isInsideZellij (matches the interface pattern of other backends).
 */
export async function isInsideZellij(): Promise<boolean> {
  return isInsideZellijSync();
}

/**
 * Check if the zellij binary is available on the system.
 */
export async function isZellijAvailable(): Promise<boolean> {
  try {
    execFileSync("which", ["zellij"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current pane ID from the ZELLIJ_PANE_ID environment variable.
 */
export function getLeaderPaneId(): string | null {
  return process.env.ZELLIJ_PANE_ID || null;
}
