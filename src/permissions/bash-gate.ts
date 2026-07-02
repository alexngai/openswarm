/**
 * bash-gate.ts — bash-specific validation gate extracted from canUseTool.
 *
 * Phase 5 Stage A — P5.Q2, P5.Q3, P5.Q12.
 * Phase 5.5 follow-up B — emit LaneEvents for Block/Warn paths (P5.Q4).
 *
 * Called from canUseTool (main.ts) after PermissionEngine.check returns Allow.
 * Runs the bash-validation pipeline and routes Block / Warn / Allow back to the
 * caller. Non-bash tools and empty commands return null (caller falls through to
 * the normal mode-allow path).
 *
 * Keeping this as a separate exported function makes the Warn routing + headless
 * toggle unit-testable without spinning up a full runPrompt() context.
 */

import { validateBashCommand } from "../tools/tier0/bash-validation/index.js";
import { classifyCommand } from "../tools/tier0/bash-validation/intent.js";
import { readHeadlessApproval } from "./headless-prompt.js";
import type { PermissionBridge } from "./bridge.js";
import type { SessionAllowRules } from "./session-rules.js";
import type { PermissionDecision } from "../engine/index.js";
import type { AgentId, PermissionMode } from "../core/types.js";
import type { ToolImpl } from "../tools/types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { BashValidationBlockedPayload, BashValidationWarnedPayload } from "../swarm/events.js";

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
  /**
   * Inject from caller (Orchestrator/host) to emit telemetry events; single-agent
   * paths can leave undefined for no-op.
   *
   * Emission is wrapped in try/catch so a faulty emitter never breaks the gate.
   */
  readonly emitLaneEvent?: (event: LaneEvent) => void;
  /**
   * Session-scoped "always allow" rules (Phase 3 B4). When present:
   *   - a Warn whose command matches a recorded rule skips the prompt, and
   *   - a Warn approved with `alwaysAllow` records a rule (vetoed for
   *     banned-broad prefixes unless mode is danger-full-access).
   * Only consulted on the Warn path — Block results and mode denials are
   * never overridden by session rules.
   */
  readonly sessionRules?: SessionAllowRules;
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
 * Extended allow result returned by bashValidationGate when a Warn path was
 * approved by the user. The `validationApproved` flag lets canUseTool in
 * main.ts skip the subsequent mode-deny prompt — one prompt per tool call
 * instead of two (v0.2.Q5 two-prompt collapse).
 *
 * The `allow: true` shape is a strict superset of PermissionDecision's allow
 * branch so it can safely stand in wherever PermissionDecision is expected.
 */
export type BashGateAllowResult =
  | { readonly allow: true; readonly validationApproved: true }
  | PermissionDecision;

/**
 * Phase 5 Stage A — bash-specific validation gate.
 *
 * Returns:
 *   - `null`                        when toolName !== "bash" or command is empty
 *                                   (caller falls through to normal allow)
 *   - `{allow: false, reason}`      for Block results
 *   - bridge / headless decision    for Warn results (user decides);
 *     approved Warn sets `validationApproved: true` (v0.2.Q5)
 *   - `null`                        for Allow results (caller falls through)
 */
// Sentinel agentId for the single-agent / canUseTool path. In a full swarm
// context the caller would supply a real agent id via deps. The cast is safe
// because AgentId is a branded string and "bash-gate" is a stable sentinel.
const BASH_GATE_AGENT_ID = "bash-gate" as AgentId;

export async function bashValidationGate(
  gateInput: BashGateInput,
  deps: BashGateDeps,
): Promise<BashGateAllowResult | null> {
  const { toolName, toolImpl, input, currentMode } = gateInput;
  const { bridge, useHeadless, cwd, headlessApproval = readHeadlessApproval, emitLaneEvent } = deps;

  // Only gate bash tool calls.
  if (toolName !== "bash") return null;

  const cmd = (input as { command?: string }).command ?? "";
  // Empty command — nothing to validate; fall through.
  if (cmd.length === 0) return null;

  const validationResult = validateBashCommand(cmd, currentMode, cwd);

  if (validationResult.kind === "block") {
    const blockedPayload: BashValidationBlockedPayload = {
      command: cmd,
      submodule: validationResult.submodule,
      reason: validationResult.reason,
      intent: classifyCommand(cmd),
    };
    try {
      emitLaneEvent?.({
        ts: Date.now(),
        agentId: BASH_GATE_AGENT_ID,
        type: "bash_validation_blocked",
        payload: blockedPayload,
      });
    } catch {
      // Faulty emitter must not break the gate.
    }
    return {
      allow: false,
      reason: `[${validationResult.submodule}] ${validationResult.reason}`,
    };
  }

  if (validationResult.kind === "warn") {
    const warnSubmodule = validationResult.submodule;
    const warnMessage = validationResult.message;
    const warnIntent = classifyCommand(cmd);

    // Session rule hit: the user already always-allowed this prefix in this
    // session — skip the repeat prompt. (Rules are only ever consulted here,
    // on the Warn path; Block above never reaches this point.)
    if (deps.sessionRules?.matches(cmd) === true) {
      try {
        emitLaneEvent?.({
          ts: Date.now(),
          agentId: BASH_GATE_AGENT_ID,
          type: "bash_validation_warned",
          payload: {
            command: cmd,
            submodule: warnSubmodule,
            message: `${warnMessage} (auto-approved by session allow rule)`,
            decision: "approved",
            intent: warnIntent,
          },
        });
      } catch {
        // Faulty emitter must not break the gate.
      }
      return { allow: true, validationApproved: true };
    }

    const warnPending = {
      toolName: toolImpl.spec.name,
      input,
      currentMode,
      requiredPermission: toolImpl.spec.requiredPermission,
      reason: `[${warnSubmodule}] ${warnMessage}`,
    };
    const result = useHeadless
      ? await headlessApproval(warnPending)
      : await bridge.request(warnPending);

    const warnedPayload: BashValidationWarnedPayload = {
      command: cmd,
      submodule: warnSubmodule,
      message: warnMessage,
      decision: result.allow ? "approved" : "denied",
      intent: warnIntent,
    };
    try {
      emitLaneEvent?.({
        ts: Date.now(),
        agentId: BASH_GATE_AGENT_ID,
        type: "bash_validation_warned",
        payload: warnedPayload,
      });
    } catch {
      // Faulty emitter must not break the gate.
    }

    // v0.2.Q5: when the Warn prompt was approved, tag the result so that
    // canUseTool in main.ts can skip the subsequent mode-deny prompt.
    // The user already approved the destructive action — a second prompt
    // for the same tool call would be redundant and annoying.
    if (result.allow) {
      // Phase 3 B4: "always allow (this session)" — record a session rule.
      // tryAdd refuses banned-broad prefixes (bash, python, bash -c, ...)
      // unless mode is danger-full-access; refusal only skips the standing
      // rule — this call was already approved and proceeds.
      if (
        deps.sessionRules !== undefined &&
        "alwaysAllow" in result &&
        result.alwaysAllow === true
      ) {
        deps.sessionRules.tryAdd(cmd, currentMode);
      }
      return { allow: true, validationApproved: true };
    }
    return result;
  }

  // kind === "allow" — fall through.
  return null;
}
