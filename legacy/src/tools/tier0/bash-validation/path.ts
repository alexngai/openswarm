/**
 * Bash command validation — path validation submodule.
 *
 * Detects commands that touch files outside the workspace or reference
 * sensitive system paths.
 *
 * Validates path arguments against the workspace policy.
 */

import * as nodePath from "node:path";
import type { ValidationResult } from "./types.js";
import { stripScratchpadPaths } from "./scratchpad.js";

const SUBMODULE = "path";

/**
 * Sensitive files that should never be written to; return block.
 */
const BLOCKED_HOT_FILES = [
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/ssh/sshd_config",
] as const;

/**
 * System paths that warrant a warning when referenced.
 */
const WARN_SYSTEM_PATHS = [
  "/etc/",
  "/usr/",
  "/System/",
  "/sbin/",
  "/lib/",
  "/boot/",
] as const;

/**
 * Validate that command paths don't include suspicious traversal patterns
 * or references to sensitive system files.
 *
 * - `/etc/passwd`, `/etc/shadow` style hot files → block.
 * - System paths (`/etc/`, `/usr/`, `/System/`, etc.) → warn.
 * - `~/` or `$HOME` references → warn (may escape workspace).
 * - `../` traversal that could escape cwd → warn.
 * - Relative or cwd-local paths → allow.
 *
 * Submodule label: "path".
 */
export function validatePath(command: string, cwd: string): ValidationResult {
  // Check for blocked hot files first (block, not warn).
  for (const hotFile of BLOCKED_HOT_FILES) {
    if (command.includes(hotFile)) {
      return {
        kind: "block",
        reason: `Command references sensitive system file '${hotFile}' — access is not permitted`,
        submodule: SUBMODULE,
      };
    }
  }

  // Warn heuristics run with scratchpad-rooted paths stripped: the session
  // scratchpad lives under the system temp dir and is permission-exempt.
  // Hot-file blocking above deliberately saw the original command.
  const sanitized = stripScratchpadPaths(command);

  // Check for system paths that warrant a warning.
  for (const sysPath of WARN_SYSTEM_PATHS) {
    if (sanitized.includes(sysPath)) {
      return {
        kind: "warn",
        message: `Command references system path '${sysPath}' — verify this is intentional`,
        submodule: SUBMODULE,
      };
    }
  }

  // Check for home directory references that could escape workspace.
  if (sanitized.includes("~/") || sanitized.includes("$HOME")) {
    return {
      kind: "warn",
      message:
        "Command references home directory — verify it stays within the workspace scope",
      submodule: SUBMODULE,
    };
  }

  // Check for directory traversal via ../
  if (sanitized.includes("../")) {
    // Heuristic: if the cwd appears in the command, traversal likely resolves
    // within the workspace. Otherwise warn.
    const normalizedCwd = nodePath.normalize(cwd);
    if (!sanitized.includes(normalizedCwd)) {
      return {
        kind: "warn",
        message:
          "Command contains directory traversal pattern '../' — verify the target path resolves within the workspace",
        submodule: SUBMODULE,
      };
    }
  }

  return { kind: "allow" };
}
