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

const SUBMODULE = "destructive";

/** Extract the first bare command token, skipping env-var prefixes. */
function extractFirstCommand(command: string): string {
  let remaining = command.trimStart();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const eqPos = remaining.indexOf("=");
    if (eqPos === -1) break;
    const beforeEq = remaining.slice(0, eqPos);
    if (beforeEq.length > 0 && /^[A-Za-z0-9_]+$/.test(beforeEq)) {
      const afterEq = remaining.slice(eqPos + 1);
      const spaceIdx = afterEq.search(/\s/);
      if (spaceIdx === -1) return "";
      remaining = afterEq.slice(spaceIdx).trimStart();
      continue;
    }
    break;
  }
  return remaining.split(/\s+/)[0] ?? "";
}

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
