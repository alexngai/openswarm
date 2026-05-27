/**
 * Bash command validation — destructive command warning submodule.
 *
 * Always-applicable (any permission mode). Warns when a command matches known
 * destructive patterns or is inherently destructive.
 *
 * Corresponds to claw's `check_destructive` (bash_validation.rs:237-273).
 */

import type { ValidationResult } from "./types.js";
import { DESTRUCTIVE_PATTERNS, ALWAYS_DESTRUCTIVE_COMMANDS } from "./constants.js";

import { extractFirstCommand } from "./utils.js";

const SUBMODULE = "destructive";

/**
 * Warn if a command looks destructive.
 *
 * Returns `{kind: "warn"}` for any dangerous command regardless of mode.
 * Always-warn semantics — even danger-full-access surfaces these.
 * Submodule label: "destructive".
 */
export function validateDestructive(command: string): ValidationResult {
  // Check known destructive patterns.
  for (const [pattern, warning] of DESTRUCTIVE_PATTERNS) {
    if (command.includes(pattern)) {
      return {
        kind: "warn",
        message: `Destructive command detected: ${warning}`,
        submodule: SUBMODULE,
      };
    }
  }

  // Check always-destructive commands.
  const first = extractFirstCommand(command);
  if ((ALWAYS_DESTRUCTIVE_COMMANDS as readonly string[]).includes(first)) {
    return {
      kind: "warn",
      message: `Command '${first}' is inherently destructive and may cause data loss`,
      submodule: SUBMODULE,
    };
  }

  // Flag any remaining "rm -rf" as a warning (the specific dangerous patterns
  // above already caught rm -rf / and rm -rf ~).
  if (command.includes("rm ") && command.includes("-r") && command.includes("-f")) {
    return {
      kind: "warn",
      message: "Recursive forced deletion detected — verify the target path is correct",
      submodule: SUBMODULE,
    };
  }

  return { kind: "allow" };
}
