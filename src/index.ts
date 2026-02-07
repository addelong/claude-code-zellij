#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { patchCliSource, findCliJs, removePatch } from "./patchCli";

const USAGE = `
claude-code-zellij - Add Zellij terminal multiplexer support to Claude Code agent teams

Usage:
  claude-code-zellij install [path-to-cli.js]   Apply the Zellij backend patch
  claude-code-zellij uninstall [path-to-cli.js]  Restore original cli.js from backup
  claude-code-zellij check [path-to-cli.js]      Check if cli.js can be patched
  claude-code-zellij help                         Show this help message

If no path is provided, the tool will search common installation locations.

Environment:
  ZELLIJ_SESSION_NAME   Set when running inside Zellij (auto-detected)
  ZELLIJ                Set to "0" inside Zellij sessions
`;

function log(msg: string): void {
  console.log(msg);
}

function error(msg: string): void {
  console.error(`Error: ${msg}`);
}

function resolveCliJs(providedPath?: string): string | null {
  if (providedPath) {
    const resolved = path.resolve(providedPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    error(`File not found: ${resolved}`);
    return null;
  }

  log("Searching for Claude Code cli.js...");
  const found = findCliJs();
  if (found) {
    log(`Found: ${found}`);
    return found;
  }

  error(
    "Could not find Claude Code cli.js. Provide the path explicitly:\n" +
      "  claude-code-zellij install /path/to/cli.js"
  );
  return null;
}

function cmdInstall(cliJsPath: string): void {
  log(`Patching ${cliJsPath}...`);

  const source = fs.readFileSync(cliJsPath, "utf-8");
  const result = patchCliSource(source);

  if (!result.success || !result.patchedSource) {
    error("Patch failed:");
    for (const f of result.failedPatches) {
      error(`  - ${f}`);
    }
    if (result.appliedPatches.length > 0) {
      log("\nPatches that would have been applied:");
      for (const p of result.appliedPatches) {
        log(`  + ${p}`);
      }
    }
    process.exit(1);
  }

  // Create backup
  const backupPath = cliJsPath + ".bak";
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(cliJsPath, backupPath);
    log(`Backup created: ${backupPath}`);
  } else {
    log(`Backup already exists: ${backupPath}`);
  }

  // Write patched content
  fs.writeFileSync(cliJsPath, result.patchedSource, "utf-8");

  log("\nPatch applied successfully:");
  for (const p of result.appliedPatches) {
    log(`  + ${p}`);
  }

  if (result.warnings.length > 0) {
    log("\nWarnings:");
    for (const w of result.warnings) {
      log(`  ! ${w}`);
    }
  }

  log(
    "\nZellij backend support is now active. Run Claude Code inside a Zellij session"
  );
  log("with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to use agent teams.");
}

function cmdUninstall(cliJsPath: string): void {
  log(`Restoring ${cliJsPath} from backup...`);

  if (removePatch(cliJsPath)) {
    log("Original cli.js restored successfully.");
  } else {
    error(`No backup found at ${cliJsPath}.bak`);
    process.exit(1);
  }
}

function cmdCheck(cliJsPath: string): void {
  log(`Checking ${cliJsPath}...`);

  const source = fs.readFileSync(cliJsPath, "utf-8");

  if (source.includes("ZellijBackendImpl")) {
    log("Status: Already patched with Zellij support.");
    return;
  }

  const result = patchCliSource(source);

  if (result.success) {
    log("Status: Ready to patch. All anchor points found.");
    log("\nPatches that will be applied:");
    for (const p of result.appliedPatches) {
      log(`  + ${p}`);
    }
  } else {
    log("Status: Cannot patch. Some anchor points not found.");
    for (const f of result.failedPatches) {
      log(`  - ${f}`);
    }
  }

  if (result.warnings.length > 0) {
    log("\nWarnings:");
    for (const w of result.warnings) {
      log(`  ! ${w}`);
    }
  }
}

// Main
const args = process.argv.slice(2);
const command = args[0];
const targetPath = args[1];

switch (command) {
  case "install": {
    const cliJs = resolveCliJs(targetPath);
    if (cliJs) cmdInstall(cliJs);
    break;
  }
  case "uninstall": {
    const cliJs = resolveCliJs(targetPath);
    if (cliJs) cmdUninstall(cliJs);
    break;
  }
  case "check": {
    const cliJs = resolveCliJs(targetPath);
    if (cliJs) cmdCheck(cliJs);
    break;
  }
  case "help":
  case "--help":
  case "-h":
    log(USAGE);
    break;
  default:
    log(USAGE);
    if (command) error(`Unknown command: ${command}`);
    process.exit(command ? 1 : 0);
}
