/**
 * Bash command validation — mode validation submodule.
 *
 * Cross-checks command intent against the current permission mode.
 * Corresponds to claw's `validate_mode` (bash_validation.rs:280-303).
 */

import type { PermissionMode } from "../../../core/types.js";
import type { ValidationResult } from "./types.js";
import { classifyCommand } from "./intent.js";
import { WRITE_COMMANDS, STATE_MODIFYING_COMMANDS } from "./constants.js";

import { extractFirstCommand } from "./utils.js";
import { stripScratchpadPaths } from "./scratchpad.js";

const SUBMODULE = "mode";

/**
 * System paths that indicate the command targets outside the workspace.
 * Used in workspace-write mode to warn about system-level writes.
 */
const SYSTEM_PATHS = [
  "/etc/",
  "/usr/",
  "/var/",
  "/boot/",
  "/sys/",
  "/proc/",
  "/dev/",
  "/sbin/",
  "/lib/",
  "/opt/",
] as const;

/**
 * Heuristic: does this command reference absolute paths outside typical workspace dirs?
 * Only applied when the first command is a write or state-modifying command.
 */
function commandTargetsOutsideWorkspace(command: string): boolean {
  const first = extractFirstCommand(command);
  const isWriteCmd =
    (WRITE_COMMANDS as readonly string[]).includes(first) ||
    (STATE_MODIFYING_COMMANDS as readonly string[]).includes(first);
  if (!isWriteCmd) return false;

  // The session scratchpad lives under the system temp dir (e.g.
  // /var/folders/... on macOS) and is permission-exempt — strip its paths
  // so writes into it don't read as system-path writes.
  const sanitized = stripScratchpadPaths(command);
  for (const sysPath of SYSTEM_PATHS) {
    if (sanitized.includes(sysPath)) return true;
  }
  return false;
}

/**
 * Cross-check command intent against the current permission mode.
 *
 * - read-only mode + write/destructive intent → block (delegated to read-only submodule;
 *   this submodule only adds workspace-write checks).
 * - workspace-write + system-admin intent → warn.
 * - danger-full-access → allow all.
 *
 * Submodule label: "mode".
 */
export function validateMode(
  command: string,
  mode: PermissionMode,
): ValidationResult {
  switch (mode) {
    case "read-only":
      // Read-only blocking is handled by the read-only submodule which runs first.
      // Return allow here to avoid double-counting.
      return { kind: "allow" };

    case "workspace-write": {
      const intent = classifyCommand(command);

      // system-admin intent (sudo, systemctl, etc.) is elevated beyond workspace scope.
      if (intent === "system-admin") {
        return {
          kind: "warn",
          message:
            "Command requires system-administrator privileges and exceeds workspace-write scope",
          submodule: SUBMODULE,
        };
      }

      // Commands targeting system paths with write access.
      if (commandTargetsOutsideWorkspace(command)) {
        return {
          kind: "warn",
          message:
            "Command appears to target files outside the workspace — requires elevated permission",
          submodule: SUBMODULE,
        };
      }

      return { kind: "allow" };
    }

    case "danger-full-access":
      return { kind: "allow" };
  }
}
