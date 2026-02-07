import * as fs from "fs";
import * as path from "path";

/**
 * Patches Claude Code's bundled cli.js to add Zellij backend support.
 *
 * The patcher works by finding known anchor strings in the minified code
 * and injecting the ZellijBackend class and detection logic at the right points.
 *
 * Anchor strings are specific to Claude Code v2.1.34. If they change in
 * future versions, the patcher will report which anchors failed to match.
 */

// The Zellij detection functions (minified to match cli.js style)
const ZELLIJ_DETECTION_CODE = [
  'function isInsideZellijSync(){return process.env.ZELLIJ==="0"&&!!process.env.ZELLIJ_SESSION_NAME}',
  "async function isInsideZellij(){return isInsideZellijSync()}",
  'async function isZellijAvailable(){try{return(await CA("which",["zellij"])).code===0}catch{return!1}}',
].join("\n");

// The ZellijBackend class (minified to match cli.js style)
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
    'let $=await CA("zellij",["action","new-pane","--name",A]);',
    'if($.code!==0){K();throw Error("Failed to create Zellij pane for "+A+": "+$.stderr)}',
    "this._pendingRelease=K;",
    'h("[ZellijBackend] Created pane for "+A+": "+H+", isFirst="+z);',
    "await new Promise(O=>setTimeout(O,200));",
    "return{paneId:H,isFirstTeammate:z}",
    "}catch(z){if(this._pendingRelease){this._pendingRelease();this._pendingRelease=null}else{K()}throw z}}",
    "async sendCommandToPane(A,q,K){",
    'try{let Y=await CA("zellij",["action","write-chars",q]);',
    'if(Y.code!==0)throw Error("Failed to write to Zellij pane "+A+": "+Y.stderr);',
    'let z=await CA("zellij",["action","write","13"]);',
    'if(z.code!==0)throw Error("Failed to send Enter to Zellij pane "+A+": "+z.stderr);',
    'h("[ZellijBackend] Sent command to pane "+A)',
    "}finally{if(this._pendingRelease){this._pendingRelease();this._pendingRelease=null}}}",
    "async setPaneBorderColor(A,q,K){}",
    "async setPaneTitle(A,q,K,Y){}",
    "async enablePaneBorderStatus(A,q){}",
    'async rebalancePanes(A,q){h("[ZellijBackend] rebalancePanes: no-op")}',
    'async killPane(A,q){h("[ZellijBackend] killPane "+A+": best-effort");return!0}',
    "async hidePane(A,q){return!1}",
    "async showPane(A,q,K){return!1}}",
  ].join(""),
  "registerZellijBackend(ZellijBackendImpl);",
].join("\n");

export interface PatchResult {
  success: boolean;
  patchedSource: string | null;
  appliedPatches: string[];
  failedPatches: string[];
  warnings: string[];
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
  if (!code.includes("BackendRegistry") || !code.includes("TmuxBackend")) {
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

  // ============================================================
  // PATCH 1: Inject ZellijBackend class before TmuxBackend
  // ============================================================
  const tmuxBackendAnchor = 'class LTA{type="tmux"';
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
    failed.push(
      "PATCH 1: Could not find TmuxBackend class anchor"
    );
  }

  // ============================================================
  // PATCH 2: Insert Zellij detection in the backend cascade
  // ============================================================
  const cascadeAnchor =
    "let K=await Ts();if(h(`[BackendRegistry] Not in tmux or iTerm2, tmux available: ${K}`)";
  if (code.includes(cascadeAnchor)) {
    const zellijCheck = [
      'if(isInsideZellijSync()){',
      'h("[BackendRegistry] Selected: zellij (running inside Zellij session)");',
      "let ZB=createZellijBackend();",
      "return qW1=ZB,ER={backend:ZB,isNative:!0,needsIt2Setup:!1},ER}",
    ].join("");
    code = code.replace(cascadeAnchor, zellijCheck + cascadeAnchor);
    applied.push("Inserted Zellij detection in backend cascade");
  } else {
    failed.push("PATCH 2: Could not find cascade anchor for Zellij detection");
  }

  // ============================================================
  // PATCH 3: Add Zellij as external fallback before the error
  // ============================================================
  const errorAnchor =
    'throw h("[BackendRegistry] ERROR: No pane backend available")';
  if (code.includes(errorAnchor)) {
    const zellijFallback = [
      "{let ZA=await isZellijAvailable();",
      'if(h("[BackendRegistry] Checking zellij availability: "+ZA),ZA){',
      'h("[BackendRegistry] Selected: zellij (external)");',
      "let ZB=createZellijBackend();",
      "return qW1=ZB,ER={backend:ZB,isNative:!1,needsIt2Setup:!1},ER}}",
    ].join("");
    code = code.replace(errorAnchor, zellijFallback + errorAnchor);
    applied.push("Added Zellij as external fallback before error");
  } else {
    failed.push("PATCH 3: Could not find error anchor for Zellij fallback");
  }

  // ============================================================
  // PATCH 4: Add "zellij" case to getBackendByType
  // ============================================================
  const backendByTypeAnchor =
    'case"tmux":return EM6();case"iterm2":return CI4()';
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
      // Replace all occurrences
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
