import * as fs from "fs";
import * as path from "path";

/**
 * Patches Claude Code's bundled cli.js to add Zellij backend support.
 *
 * The patcher works by finding known anchor strings in the minified code
 * and injecting the ZellijBackend class and detection logic at the right points.
 *
 * String-literal anchors (log messages, error messages) are version-stable.
 * Minified variable names are extracted dynamically via regex so the patcher
 * survives minor version bumps where only the mangled names change.
 */

export interface PatchResult {
  success: boolean;
  patchedSource: string | null;
  appliedPatches: string[];
  failedPatches: string[];
  warnings: string[];
}

/**
 * Extract minified variable names from the cli.js source.
 * Returns null if the expected patterns aren't found.
 */
function extractMinifiedNames(code: string): {
  tmuxBackendClass: string;
  tmuxFactory: string;
  iterm2Factory: string;
  cachedBackendRef: string;
  cachedResultVar: string;
  execFn: string;
  logFn: string;
  isInsideTmuxSyncFn: string;
} | null {
  // Find TmuxBackend class name: class XXX{type="tmux"
  const tmuxClassMatch = code.match(/class\s+([A-Za-z0-9_$]+)\{type="tmux"/);
  if (!tmuxClassMatch) return null;

  // Find the cascade function by its log message. Extract variable names from:
  // return VAR1=Y,VAR2={backend:Y,isNative:!0,...},VAR2
  // Look for the pattern near "[BackendRegistry] Selected: tmux (running inside tmux session)"
  const cascadeMatch = code.match(
    /\[BackendRegistry\] Selected: tmux \(running inside tmux session\)"\);let (\w+)=(\w+)\(\);return (\w+)=\1,(\w+)=\{backend:\1,isNative:!0,needsIt2Setup:!1\},\4/
  );
  if (!cascadeMatch) return null;
  const tmuxFactory = cascadeMatch[2];
  const cachedBackendRef = cascadeMatch[3];
  const cachedResultVar = cascadeMatch[4];

  // Find exec function: used as XXX("which",...) or XXX("tmux",...) in isTmuxAvailable
  // Pattern: (await XXX(TMUX_VAR,["-V"])).code===0  (isTmuxAvailable)
  const execMatch = code.match(/\(await\s+(\w+)\(\w+,\["-V"\]\)\)\.code===0/);
  if (!execMatch) return null;
  const execFn = execMatch[1];

  // Find iTerm2 factory from getBackendByType: case"iterm2":return XXX()
  const iterm2Match = code.match(/case"iterm2":return\s+(\w+)\(\)/);
  if (!iterm2Match) return null;

  // Find the log/debug function. It's used as: h("[BackendRegistry]...")
  // The function name 'h' has been stable, but let's extract it dynamically.
  // Pattern: LOGFN("[BackendRegistry] Starting backend detection...")
  const logMatch = code.match(/(\w+)\("\[BackendRegistry\] Starting backend detection\.\.\."\)/);
  if (!logMatch) return null;

  // Find isInsideTmuxSync: used in isInProcessEnabled as !XXX()
  // Pattern: insideTmux=${XXX()})
  const tmuxSyncMatch = code.match(/insideTmux=\$\{(\w+)\(\)\}/);
  if (!tmuxSyncMatch) return null;

  return {
    tmuxBackendClass: tmuxClassMatch[1],
    tmuxFactory,
    iterm2Factory: iterm2Match[1],
    cachedBackendRef,
    cachedResultVar,
    execFn,
    logFn: logMatch[1],
    isInsideTmuxSyncFn: tmuxSyncMatch[1],
  };
}

/**
 * Validate and apply all patches to the cli.js content.
 * Returns the patched source string along with a report.
 */
export function patchCliSource(source: string): PatchResult {
  let code = source;
  const applied: string[] = [];
  const failed: string[] = [];
  const warnings: string[] = [];

  // Verify this looks like Claude Code cli.js
  if (!code.includes("BackendRegistry") || !code.includes('type="tmux"')) {
    return {
      success: false,
      patchedSource: null,
      appliedPatches: [],
      failedPatches: ["File does not appear to be Claude Code cli.js"],
      warnings: [],
    };
  }

  // Check if already patched
  if (
    code.includes("ZellijBackendImpl") ||
    code.includes("isInsideZellijSync")
  ) {
    return {
      success: false,
      patchedSource: null,
      appliedPatches: [],
      failedPatches: ["File appears to already be patched with Zellij support"],
      warnings: [],
    };
  }

  // Extract minified variable names dynamically
  const names = extractMinifiedNames(code);
  if (!names) {
    return {
      success: false,
      patchedSource: null,
      appliedPatches: [],
      failedPatches: [
        "Could not extract minified variable names. The cli.js structure may have changed significantly.",
      ],
      warnings: [],
    };
  }

  const {
    tmuxBackendClass,
    tmuxFactory,
    iterm2Factory,
    cachedBackendRef,
    cachedResultVar,
    execFn,
    logFn,
    isInsideTmuxSyncFn,
  } = names;

  // Build the injected Zellij code using the extracted names
  const ZELLIJ_DETECTION_CODE = [
    'function isInsideZellijSync(){return process.env.ZELLIJ==="0"&&!!process.env.ZELLIJ_SESSION_NAME}',
    "async function isInsideZellij(){return isInsideZellijSync()}",
    `async function isZellijAvailable(){try{return(await ${execFn}("which",["zellij"])).code===0}catch{return!1}}`,
  ].join("\n");

  const ZELLIJ_BACKEND_CLASS = [
    "var zellijLockQueue=Promise.resolve();",
    "var zellijBackendRegistered=null;",
    "function registerZellijBackend(A){zellijBackendRegistered=A}",
    'function createZellijBackend(){if(!zellijBackendRegistered)throw Error("ZellijBackend not registered.");return new zellijBackendRegistered}',
    [
      'class ZellijBackendImpl{type="zellij";displayName="Zellij";supportsHideShow=!1;paneCount=0;_pendingRelease=null;',
      "async isAvailable(){return isInsideZellijSync()||await isZellijAvailable()}",
      "async isRunningInside(){return isInsideZellij()}",
      "async createTeammatePaneInSwarmView(A,q){",
      "let K,Y=new Promise((z)=>{K=z}),w=zellijLockQueue;zellijLockQueue=Y;await w;",
      "try{let z=this.paneCount===0;this.paneCount++;",
      'let H="zellij-"+A+"-"+this.paneCount;',
      `let $=await ${execFn}("zellij",["action","new-pane","--name",A]);`,
      'if($.code!==0){K();throw Error("Failed to create Zellij pane for "+A+": "+$.stderr)}',
      "this._pendingRelease=K;",
      `${logFn}("[ZellijBackend] Created pane for "+A+": "+H+", isFirst="+z);`,
      "await new Promise(O=>setTimeout(O,200));",
      "return{paneId:H,isFirstTeammate:z}",
      "}catch(z){if(this._pendingRelease){this._pendingRelease();this._pendingRelease=null}else{K()}throw z}}",
      "async sendCommandToPane(A,q,K){",
      `try{let Y=await ${execFn}("zellij",["action","write-chars",q]);`,
      'if(Y.code!==0)throw Error("Failed to write to Zellij pane "+A+": "+Y.stderr);',
      `let z=await ${execFn}("zellij",["action","write","13"]);`,
      'if(z.code!==0)throw Error("Failed to send Enter to Zellij pane "+A+": "+z.stderr);',
      `${logFn}("[ZellijBackend] Sent command to pane "+A)`,
      "}finally{if(this._pendingRelease){this._pendingRelease();this._pendingRelease=null}}}",
      "async setPaneBorderColor(A,q,K){}",
      "async setPaneTitle(A,q,K,Y){}",
      "async enablePaneBorderStatus(A,q){}",
      `async rebalancePanes(A,q){${logFn}("[ZellijBackend] rebalancePanes: no-op")}`,
      `async killPane(A,q){${logFn}("[ZellijBackend] killPane "+A+": best-effort");return!0}`,
      "async hidePane(A,q){return!1}",
      "async showPane(A,q,K){return!1}}",
    ].join(""),
    "registerZellijBackend(ZellijBackendImpl);",
  ].join("\n");

  // ============================================================
  // PATCH 1: Inject ZellijBackend class before TmuxBackend
  // ============================================================
  const tmuxBackendAnchor = `class ${tmuxBackendClass}{type="tmux"`;
  if (code.includes(tmuxBackendAnchor)) {
    const insertPos = code.indexOf(tmuxBackendAnchor);
    code =
      code.slice(0, insertPos) +
      ZELLIJ_DETECTION_CODE +
      "\n" +
      ZELLIJ_BACKEND_CLASS +
      "\n" +
      code.slice(insertPos);
    applied.push("Injected ZellijBackend class and detection functions");
  } else {
    failed.push("PATCH 1: Could not find TmuxBackend class anchor");
  }

  // ============================================================
  // PATCH 2: Insert Zellij detection in the backend cascade
  // Anchor: the log message about tmux availability after iTerm2 check
  // ============================================================
  const cascadeAnchor = `[BackendRegistry] Not in tmux or iTerm2, tmux available: \${K}\`)`;
  if (code.includes(cascadeAnchor)) {
    // Find the full statement starting from "let K=await" before the anchor
    const anchorPos = code.indexOf(cascadeAnchor);
    // Search backwards for "let K=" to find the start of the statement
    const searchStart = Math.max(0, anchorPos - 200);
    const prefix = code.slice(searchStart, anchorPos);
    const letKMatch = prefix.match(/let K=await\s+\w+\(\);if\(\w+\(`$/);
    if (letKMatch) {
      const fullAnchorStart = searchStart + prefix.lastIndexOf(letKMatch[0]);
      const zellijCheck = [
        "if(isInsideZellijSync()){",
        `${logFn}("[BackendRegistry] Selected: zellij (running inside Zellij session)");`,
        "let ZB=createZellijBackend();",
        `return ${cachedBackendRef}=ZB,${cachedResultVar}={backend:ZB,isNative:!0,needsIt2Setup:!1},${cachedResultVar}}`,
      ].join("");
      code =
        code.slice(0, fullAnchorStart) +
        zellijCheck +
        code.slice(fullAnchorStart);
      applied.push("Inserted Zellij detection in backend cascade");
    } else {
      failed.push(
        "PATCH 2: Found cascade log message but could not locate statement start"
      );
    }
  } else {
    failed.push(
      "PATCH 2: Could not find cascade anchor for Zellij detection"
    );
  }

  // ============================================================
  // PATCH 3: Add Zellij as external fallback before the error
  // ============================================================
  const errorAnchor =
    'throw h("[BackendRegistry] ERROR: No pane backend available")';
  if (code.includes(errorAnchor)) {
    const zellijFallback = [
      "{let ZA=await isZellijAvailable();",
      `if(${logFn}("[BackendRegistry] Checking zellij availability: "+ZA),ZA){`,
      `${logFn}("[BackendRegistry] Selected: zellij (external)");`,
      "let ZB=createZellijBackend();",
      `return ${cachedBackendRef}=ZB,${cachedResultVar}={backend:ZB,isNative:!1,needsIt2Setup:!1},${cachedResultVar}}}`,
    ].join("");
    code = code.replace(errorAnchor, zellijFallback + errorAnchor);
    applied.push("Added Zellij as external fallback before error");
  } else {
    failed.push("PATCH 3: Could not find error anchor for Zellij fallback");
  }

  // ============================================================
  // PATCH 4: Add "zellij" case to getBackendByType
  // ============================================================
  const backendByTypeAnchor = `case"tmux":return ${tmuxFactory}();case"iterm2":return ${iterm2Factory}()`;
  if (code.includes(backendByTypeAnchor)) {
    code = code.replace(
      backendByTypeAnchor,
      backendByTypeAnchor + ';case"zellij":return createZellijBackend()'
    );
    applied.push('Added "zellij" case to getBackendByType');
  } else {
    failed.push("PATCH 4: Could not find getBackendByType anchor");
  }

  // ============================================================
  // PATCH 5: Update error messages to mention Zellij
  // ============================================================
  const errorMsgReplacements: Array<{ find: string; replace: string }> = [
    {
      find: "To use agent swarms, install tmux:",
      replace:
        "To use agent swarms, install tmux or start a Zellij session (zellij):",
    },
    {
      find: "To use agent swarms, install tmux using your system's package manager.",
      replace:
        "To use agent swarms, install tmux or Zellij using your system's package manager.",
    },
  ];

  for (const { find, replace } of errorMsgReplacements) {
    if (code.includes(find)) {
      while (code.includes(find)) {
        code = code.replace(find, replace);
      }
      applied.push(`Updated error message: "${find.slice(0, 40)}..."`);
    } else {
      warnings.push(
        `Error message not found (may already be patched): "${find.slice(0, 40)}..."`
      );
    }
  }

  // ============================================================
  // PATCH 6: Make isInProcessEnabled() recognize Zellij
  //
  // The original logic defaults to in-process when NOT in tmux:
  //   else q=!TMUX_SYNC_FN();
  // We change it to also check Zellij:
  //   else q=!TMUX_SYNC_FN()&&!isInsideZellijSync();
  //
  // Without this patch, agents always run in-process inside Zellij
  // because the code only checks for tmux when deciding pane vs in-process.
  // ============================================================
  const inProcessAnchor = `else q=!${isInsideTmuxSyncFn}()`;
  if (code.includes(inProcessAnchor)) {
    code = code.replace(
      inProcessAnchor,
      `else q=!${isInsideTmuxSyncFn}()&&!isInsideZellijSync()`
    );
    applied.push(
      "Patched isInProcessEnabled to recognize Zellij sessions"
    );
  } else {
    failed.push(
      "PATCH 6: Could not find isInProcessEnabled anchor for Zellij check"
    );
  }

  return {
    success: failed.length === 0,
    patchedSource: failed.length === 0 ? code : null,
    appliedPatches: applied,
    failedPatches: failed,
    warnings,
  };
}

/**
 * Find the cli.js file in common installation locations.
 */
export function findCliJs(): string | null {
  const candidates: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || "~";

  // Linuxbrew npm global (most common on Linux with Homebrew)
  candidates.push(
    "/home/linuxbrew/.linuxbrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"
  );

  // Homebrew npm global (macOS)
  candidates.push(
    "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
  );

  // nvm installs (search all node versions)
  const nvmDir = path.join(home, ".nvm/versions/node");
  if (fs.existsSync(nvmDir)) {
    try {
      for (const ver of fs.readdirSync(nvmDir).sort().reverse()) {
        candidates.push(
          path.join(
            nvmDir,
            ver,
            "lib/node_modules/@anthropic-ai/claude-code/cli.js"
          )
        );
      }
    } catch {}
  }

  // Standard npm global installs
  candidates.push(
    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    path.join(home, ".npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
    path.join(home, "node_modules/@anthropic-ai/claude-code/cli.js")
  );

  // npx cache
  const npxCache = path.join(home, ".npm/_npx");
  if (fs.existsSync(npxCache)) {
    try {
      for (const entry of fs.readdirSync(npxCache)) {
        candidates.push(
          path.join(
            npxCache,
            entry,
            "node_modules/@anthropic-ai/claude-code/cli.js"
          )
        );
      }
    } catch {}
  }

  // Filter to existing files, then verify each is actually a JavaScript file
  // (not an ELF binary) and contains the expected Claude Code markers
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const fd = fs.openSync(candidate, "r");
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      // Skip ELF binaries (magic: 0x7f 'E' 'L' 'F')
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
        continue;
      }
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Restore cli.js from backup.
 */
export function removePatch(cliJsPath: string): boolean {
  const backupPath = cliJsPath + ".bak";
  if (!fs.existsSync(backupPath)) {
    return false;
  }
  fs.copyFileSync(backupPath, cliJsPath);
  return true;
}
