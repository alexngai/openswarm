/**
 * AcpPermissionRouter — the team analog of Stage A's AcpPermissionBridge.
 *
 * Implements the swarm InteractionHandler: a member's mode-denied tool call
 * arrives over IPC (B0.3), and this routes it to the ACP client via
 * conn.requestPermission, attributing it to the member by role ([role] title,
 * doc 33 §6) and mapping the outcome back to allow/deny.
 *
 * The router is mutable because the orchestrator (and thus the host that holds
 * it) is built before the ACP connection exists: runAcpTeam sets the conn and
 * roster source; AcpTeamAgent sets the active session id per prompt.
 */

import * as crypto from "node:crypto";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type {
  InteractionHandler,
  PermissionRequest,
  PermissionDecisionResponse,
} from "../swarm/host.js";
import type { AgentId } from "../core/types.js";
import type { MemberInfo } from "../swarm/team-session.js";
import { toolKind, toolTitle } from "./tool-kind.js";

type Roster = ReadonlyMap<AgentId, MemberInfo> | undefined;

export class AcpPermissionRouter implements InteractionHandler {
  private conn?: Pick<AgentSideConnection, "requestPermission">;
  private sessionId?: string;
  private rosterFn?: () => Roster;

  setConn(conn: Pick<AgentSideConnection, "requestPermission">): void {
    this.conn = conn;
  }

  setActiveSession(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  setRoster(fn: () => Roster): void {
    this.rosterFn = fn;
  }

  async requestPermission(
    req: PermissionRequest,
  ): Promise<PermissionDecisionResponse> {
    if (this.conn === undefined || this.sessionId === undefined) {
      return { outcome: "deny", reason: "no active ACP session" };
    }
    const role =
      req.agentId !== undefined
        ? this.rosterFn?.()?.get(req.agentId as AgentId)?.role
        : undefined;
    const prefix = role !== undefined ? `[${role}] ` : "";

    const res = await this.conn.requestPermission({
      sessionId: this.sessionId,
      toolCall: {
        toolCallId: crypto.randomUUID(),
        title: prefix + toolTitle(req.toolName, req.input),
        kind: toolKind(req.toolName),
        rawInput: req.input,
      },
      options: [
        {
          optionId: "allow_always",
          name: `Always allow ${req.toolName}`,
          kind: "allow_always",
        },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });

    const outcome = res.outcome;
    if (outcome.outcome === "cancelled") {
      return { outcome: "deny", reason: "cancelled" };
    }
    if (outcome.optionId === "reject") {
      return { outcome: "deny", reason: "denied by user" };
    }
    return { outcome: "allow" };
  }
}
