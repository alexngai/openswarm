/**
 * bash-gate.ts — bash-specific validation gate extracted from canUseTool.
 *
 * Phase 5 Stage A — P5.Q2, P5.Q3, P5.Q12.
 *
 * Called from canUseTool (main.ts) after PermissionEngine.check returns Allow.
 * Runs the bash-validation pipeline and routes Block / Warn / Allow back to the
 * caller. Non-bash tools and empty commands return null (caller falls through to
 * the normal mode-allow path).
 *
 * Keeping this as a separate exported function makes the Warn routing + headless
 * toggle unit-testable without spinning up a full runPrompt() context.
 *
 * TODO(Phase 5 Stage B): emit LaneEvent `bash_validation_blocked` /
 * `bash_validation_warned` from this function once the lane-event discriminated
 * union lands (P5.Q4). The function signature accepts `deps` so that field can
 * be added without breaking call sites.
 */

import { validateBashCommand } from "../tools/tier0/bash-validation/index.js";
import { readHeadlessApproval } from "./headless-prompt.js";
import type { PermissionBridge } from "./bridge.js";
import type { PermissionDecision } from "../engine/index.js";
import type { PermissionMode } from "../core/types.js";
import type { ToolImpl } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BashGateDeps {
  readonly bridge: PermissionBridge;
  readonly useHeadless: boolean;
  readonly cwd: string;
  /**
   * Override the headless approval function — used in tests to inject a fake
   * stdin/stdout without touching process.stdin / process.stdout.
   */
  readonly headlessApproval?: typeof readHeadlessApproval;
}

export interface BashGateInput {
  readonly toolName: string;
  readonly toolImpl: ToolImpl;
  readonly input: unknown;
  readonly currentMode: PermissionMode;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Phase 5 Stage A — bash-specific validation gate.
 *
 * Returns:
 *   - `null`                        when toolName !== "bash" or command is empty
 *                                   (caller falls through to normal allow)
 *   - `{allow: false, reason}`      for Block results
 *   - bridge / headless decision    for Warn results (user decides)
 *   - `null`                        for Allow results (caller falls through)
 */
export async function bashValidationGate(
  gateInput: BashGateInput,
  deps: BashGateDeps,
): Promise<PermissionDecision | null> {
  const { toolName, toolImpl, input, currentMode } = gateInput;
  const { bridge, useHeadless, cwd, headlessApproval = readHeadlessApproval } = deps;

  // Only gate bash tool calls.
  if (toolName !== "bash") return null;

  const cmd = (input as { command?: string }).command ?? "";
  // Empty command — nothing to validate; fall through.
  if (cmd.length === 0) return null;

  const validationResult = validateBashCommand(cmd, currentMode, cwd);

  if (validationResult.kind === "block") {
    return {
      allow: false,
      reason: `[${validationResult.submodule}] ${validationResult.reason}`,
    };
  }

  if (validationResult.kind === "warn") {
    const warnPending = {
      toolName: toolImpl.spec.name,
      input,
      currentMode,
      requiredPermission: toolImpl.spec.requiredPermission,
      reason: `[${validationResult.submodule}] ${validationResult.message}`,
    };
    if (useHeadless) {
      return await headlessApproval(warnPending);
    }
    return await bridge.request(warnPending);
  }

  // kind === "allow" — fall through.
  return null;
}
