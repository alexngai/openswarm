/**
 * Bash command validation — top-level dispatcher.
 *
 * Runs the 6 submodules in order. First non-Allow result wins.
 * If all submodules Allow, returns Allow.
 *
 * Phase 5 Stage A — design lock: P5.Q2, P5.Q3, P5.Q12.
 * Gate fires in canUseTool (main.ts) after PermissionEngine.check returns Allow.
 *
 * Submodule order:
 *   1. read-only   — block writes in read-only mode
 *   2. destructive — warn on always-dangerous patterns (any mode)
 *   3. mode        — cross-check intent vs permission mode
 *   4. sed         — warn on sed -i without backup
 *   5. path        — warn/block on system paths and traversals
 */

import type { PermissionMode } from "../../../core/types.js";
import type { ValidationResult } from "./types.js";
import { validateReadOnly } from "./read-only.js";
import { validateDestructive } from "./destructive.js";
import { validateMode } from "./mode.js";
import { validateSed } from "./sed.js";
import { validatePath } from "./path.js";

export type { ValidationResult } from "./types.js";
export type { CommandIntent } from "./intent.js";
export { classifyCommand } from "./intent.js";

/**
 * Run the full bash command validation pipeline.
 *
 * @param command - The raw bash command string.
 * @param mode    - The active permission mode.
 * @param cwd     - The working directory (used by path submodule).
 * @returns The first non-Allow result, or Allow if all submodules pass.
 */
export function validateBashCommand(
  command: string,
  mode: PermissionMode,
  cwd: string,
): ValidationResult {
  const submodules: Array<() => ValidationResult> = [
    () => validateReadOnly(command, mode),
    () => validateDestructive(command),
    () => validateMode(command, mode),
    () => validateSed(command),
    () => validatePath(command, cwd),
  ];

  for (const check of submodules) {
    const result = check();
    if (result.kind !== "allow") return result;
  }

  return { kind: "allow" };
}
