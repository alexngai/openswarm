/**
 * AcpPermissionBridge — routes the engine's permission prompts (mode-deny and
 * bash-validation Warn) to the ACP client via `conn.requestPermission`, then
 * maps the user's outcome back to a PermissionDecision.
 *
 * Because it extends PermissionBridge, `makeCanUseTool` reuses its body
 * unchanged: pass this bridge with `useHeadless: false` and both prompt points
 * route through ACP (docs/archive/32 §8).
 *
 * Limitation: the engine's PermissionGate fires with (toolName, input) but no
 * tool_use id, so the permission request carries a fresh toolCallId rather than
 * correlating to the streamed tool_call. The human still sees a titled prompt;
 * tighter correlation is a later enhancement.
 */

import * as crypto from "node:crypto";
import { PermissionBridge } from "../permissions/bridge.js";
import type { BridgeDecision } from "../permissions/bridge.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { PendingPermission } from "../ui/repl/state.js";
import { toolKind, toolTitle } from "./tool-kind.js";

export class AcpPermissionBridge extends PermissionBridge {
  constructor(
    private readonly conn: Pick<AgentSideConnection, "requestPermission">,
    private readonly sessionId: string,
  ) {
    super();
  }

  override async request(
    pending: PendingPermission,
  ): Promise<BridgeDecision> {
    const res = await this.conn.requestPermission({
      sessionId: this.sessionId,
      toolCall: {
        toolCallId: crypto.randomUUID(),
        title: toolTitle(pending.toolName, pending.input),
        kind: toolKind(pending.toolName),
        rawInput: pending.input,
      },
      options: [
        {
          optionId: "allow_always",
          name: `Always allow ${pending.toolName} (this session)`,
          kind: "allow_always",
        },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });

    const outcome = res.outcome;
    if (outcome.outcome === "cancelled") {
      return { allow: false, reason: "cancelled" };
    }
    if (outcome.optionId === "reject") {
      return { allow: false, reason: "denied by user" };
    }
    // "allow_always" additionally records a session-scoped allow rule in the
    // bash gate (Phase 3 B4; banned-broad prefixes are refused there).
    if (outcome.optionId === "allow_always") {
      return { allow: true, alwaysAllow: true };
    }
    return { allow: true };
  }
}
