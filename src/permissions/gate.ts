/**
 * makeCanUseTool — factory for the engine's `canUseTool` permission gate.
 *
 * Extracted verbatim from runPrompt (src/cli/main.ts) so the single-agent CLI,
 * the ACP adapter (docs/30, docs/32), and any other engine driver share one
 * gate implementation instead of duplicating the bash-gate + mode-check logic.
 *
 * The two prompt points — the bash-validation Warn prompt and the mode-deny
 * prompt — route through the injected `bridge` (TTY) or `readHeadlessApproval`
 * (headless). An ACP driver supplies a `PermissionBridge` subclass whose
 * `request()` forwards to `client.requestPermission` and sets
 * `useHeadless: false`, so this body is reused unchanged (docs/32 §8).
 *
 * Ordering (doc 17 "Phase 2 — design lock" + Phase 5 stage A bash gate):
 *   1. Unknown tool → hard deny.
 *   2. Bash-validation gate fires first. Block → deny. Warn → prompt;
 *      approve falls through (or, when validationApproved, fast-allows to avoid
 *      a second prompt for the same call). Non-bash tools return null → fall through.
 *   3. Mode allows → fast-path allow.
 *   4. Mode denies → dispatch a prompt (headless stdin or bridge).
 */

import { bashValidationGate } from "./bash-gate.js";
import { readHeadlessApproval } from "./headless-prompt.js";
import type { PermissionBridge } from "./bridge.js";
import type { PermissionEngine } from "./index.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { PermissionGate } from "../engine/index.js";
import type { PermissionMode } from "../core/types.js";

export interface CanUseToolDeps {
  readonly dispatcher: ToolDispatcher;
  readonly permEngine: PermissionEngine;
  /** Prompt driver for the bash Warn path and the mode-deny path (TTY / ACP). */
  readonly bridge: PermissionBridge;
  /** When true, mode-deny prompts read from stdin instead of the bridge. */
  readonly useHeadless: boolean;
  /**
   * Live read of the current permission mode. The CLI mutates this across
   * turns via /permissions, so the gate reads it fresh on every call.
   */
  readonly getCurrentMode: () => PermissionMode;
  readonly cwd: string;
  /**
   * Single-agent paths pass a no-op; swarm workers emit to their lane so the
   * orchestrator sees validation events.
   */
  readonly emitLaneEvent?: (event: unknown) => void;
}

export function makeCanUseTool(deps: CanUseToolDeps): PermissionGate {
  const { dispatcher, permEngine, bridge, useHeadless, getCurrentMode, cwd } = deps;
  const emitLaneEvent = deps.emitLaneEvent ?? (() => {});

  return async (toolName, input) => {
    const toolImpl = dispatcher.get(toolName);
    if (toolImpl === undefined) {
      return { allow: false, reason: `unknown tool: ${toolName}` };
    }

    const currentMode = getCurrentMode();

    // Bash command validation gate fires first. For non-bash tools the gate
    // returns null and we fall through to the mode check.
    const bashGateResult = await bashValidationGate(
      { toolName, toolImpl, input, currentMode },
      { bridge, useHeadless, cwd, emitLaneEvent },
    );
    // Block or Warn-denied short-circuit: never run the mode check, never
    // surface a second prompt for the same tool call.
    if (bashGateResult !== null && !bashGateResult.allow) return bashGateResult;

    // Two-prompt collapse: a bash Warn the user approved skips the mode-deny
    // prompt entirely — the destructive action was already explicitly allowed.
    if (
      bashGateResult !== null &&
      bashGateResult.allow &&
      "validationApproved" in bashGateResult &&
      bashGateResult.validationApproved
    ) {
      return { allow: true };
    }

    const modeDecision = permEngine.check(toolImpl.spec, input);
    if (!modeDecision.allow) {
      const pending = {
        toolName: toolImpl.spec.name,
        input,
        currentMode,
        requiredPermission: toolImpl.spec.requiredPermission,
        reason: modeDecision.reason,
      };
      // Headless: emit JSONL `permission_required`, block on stdin, EOF = deny.
      // TTY/ACP: dispatch through the bridge and await the decision.
      if (useHeadless) {
        return await readHeadlessApproval(pending);
      }
      return await bridge.request(pending);
    }

    return modeDecision;
  };
}
