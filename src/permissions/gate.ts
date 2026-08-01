/**
 * makeCanUseTool — factory for the engine's `canUseTool` permission gate.
 *
 * Extracted verbatim from runPrompt (src/cli/main.ts) so the single-agent CLI,
 * the ACP adapter, and any other engine driver share one
 * gate implementation instead of duplicating the bash-gate + mode-check logic.
 *
 * The two prompt points — the bash-validation Warn prompt and the mode-deny
 * prompt — route through the injected `bridge` (TTY) or `readHeadlessApproval`
 * (headless). An ACP driver supplies a `PermissionBridge` subclass whose
 * `request()` forwards to `client.requestPermission` and sets
 * `useHeadless: false`, so this body is reused unchanged.
 *
 * Ordering (doc 17 "Phase 2 — design lock" + Phase 5 stage A bash gate):
 *   1. Unknown tool → hard deny.
 *   2. Declared paths that escape the workspace → hard deny, before any prompt.
 *      An out-of-workspace path is not something to ask about.
 *   3. A call that named its resources is authorized per resource and returns.
 *   4. Otherwise the bash-validation gate fires. Block → deny. Warn → prompt;
 *      approve falls through (or, when validationApproved, fast-allows to avoid
 *      a second prompt for the same call). Non-bash tools return null → fall through.
 *   5. Mode allows → fast-path allow.
 *   6. Mode denies → dispatch a prompt (headless stdin or bridge).
 *
 * Steps 3 and 5/6 are alternatives, not a sequence. Per-resource authorization
 * is exact for a call whose paths are known, and re-running the tool-level mode
 * check afterwards would prompt twice for one decision. The mode path remains
 * for everything that cannot name what it touches: bash, plugin tools, MCP
 * tools, and anything declaring `all()`. `rulesForMode` keeps the two in
 * agreement, so which path a call takes changes when it is remembered, not
 * whether it is allowed.
 */

import { bashValidationGate } from "./bash-gate.js";
import { readHeadlessApproval } from "./headless-prompt.js";
import { makeResourceDeriver } from "./path-containment.js";
import { makeApprovalBroker } from "./policy-broker.js";
import { rulesForMode } from "./mode-rules.js";
import { PolicyEngine } from "../kernel/policy-engine.js";
import type { PermissionBridge } from "./bridge.js";
import type { SessionAllowRules } from "./session-rules.js";
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
  /**
   * Session-scoped bash "always allow" rules (Phase 3 B4). Optional; when
   * present it is threaded into the bash gate so approved Warns can be
   * remembered for the session.
   */
  readonly sessionRules?: SessionAllowRules;
  /**
   * Identity of the trusted workspace, read fresh whenever a grant is used, so
   * consent given about one repository state does not carry into another.
   *
   * Today the digest is computed once at startup, so tagging is what this
   * buys: any later re-verification invalidates the grants it should, and the
   * grant record says what it was given about. The re-verification itself is
   * not here (docs/67 WP-09).
   */
  readonly trustBinding?: () => string | undefined;
}

export function makeCanUseTool(deps: CanUseToolDeps): PermissionGate {
  const { dispatcher, permEngine, bridge, useHeadless, getCurrentMode, cwd } = deps;
  const emitLaneEvent = deps.emitLaneEvent ?? (() => {});
  const derive = makeResourceDeriver(cwd);
  const policy = new PolicyEngine(
    () => rulesForMode(getCurrentMode()),
    makeApprovalBroker({ bridge, useHeadless, getCurrentMode }),
    { ...(deps.trustBinding !== undefined && { trustBinding: deps.trustBinding }) },
  );

  return async (toolName, input) => {
    const toolImpl = dispatcher.get(toolName);
    if (toolImpl === undefined) {
      return { allow: false, reason: `unknown tool: ${toolName}` };
    }

    const derived = await derive(toolImpl, input);

    // Containment precedes every prompt. A path outside the workspace is
    // refused rather than escalated: no permission mode grants it, so asking
    // would only offer the user a choice they do not have.
    if (derived.kind === "denied") return derived.decision;

    const currentMode = getCurrentMode();

    // Resources this call named are authorized per resource, which is what
    // lets an approval bind to one path instead of to a tool name. This is
    // authoritative for such a call: running the tool-level mode check after
    // it would ask the user a second time about a decision already made.
    if (derived.kind === "requests" && derived.requests.length > 0) {
      for (const request of derived.requests) {
        const decision = await policy.authorize(request);
        if (!decision.allowed) {
          return {
            allow: false,
            reason: decision.reason ?? `denied by policy (${decision.source})`,
          };
        }
      }
      return { allow: true };
    }

    // Bash command validation gate fires first. For non-bash tools the gate
    // returns null and we fall through to the mode check.
    const bashGateResult = await bashValidationGate(
      { toolName, toolImpl, input, currentMode },
      {
        bridge,
        useHeadless,
        cwd,
        emitLaneEvent,
        ...(deps.sessionRules !== undefined && { sessionRules: deps.sessionRules }),
      },
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

    // Check against the LIVE mode (getCurrentMode), not the engine's frozen
    // construction mode, so `/permissions` and `request_permissions` elevation
    // actually reduce future denials mid-session.
    const modeDecision = permEngine.check(toolImpl.spec, input, currentMode);
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
