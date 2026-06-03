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
 *
 * Parallelism (doc 31 Q2): N members can hit gated tools at once. To avoid
 * stacking N modals on the client, prompts are **serialized** (one outstanding
 * at a time) and an `allow_always` decision **persists team-wide** for the
 * connection — so a later request for the same tool is auto-allowed without a
 * second prompt (de-facto coalescing for the common "allow always" case).
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
import { swarmMemberMeta, withSwarmMeta } from "./swarm-meta.js";

type Roster = ReadonlyMap<AgentId, MemberInfo> | undefined;

export class AcpPermissionRouter implements InteractionHandler {
  private conn?: Pick<AgentSideConnection, "requestPermission">;
  private sessionId?: string;
  private rosterFn?: () => Roster;
  /** Tools the user chose "always allow" for — team-wide, connection lifetime. */
  private readonly alwaysAllowed = new Set<string>();
  /** Serialization chain: only one prompt is outstanding to the client at a time. */
  private queue: Promise<unknown> = Promise.resolve();

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
    // Fast path: a tool the user already chose to always allow needs no prompt
    // (and no serialization) — this is what keeps parallel members flowing.
    if (this.alwaysAllowed.has(req.toolName)) {
      return { outcome: "allow" };
    }
    // Otherwise serialize: chain behind any in-flight prompt so concurrent
    // escalations don't stack modals on the client (Q2). Failures don't break
    // the chain.
    const run = this.queue.then(() => this.promptOnce(req));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One serialized prompt to the client; updates the always-allow set. */
  private async promptOnce(
    req: PermissionRequest,
  ): Promise<PermissionDecisionResponse> {
    // Re-check: an earlier queued prompt may have just set always-allow for this
    // tool (coalesces a burst of same-tool requests into a single prompt).
    if (this.alwaysAllowed.has(req.toolName)) {
      return { outcome: "allow" };
    }
    if (this.conn === undefined || this.sessionId === undefined) {
      return { outcome: "deny", reason: "no active ACP session" };
    }
    const rosterMember =
      req.agentId !== undefined
        ? this.rosterFn?.()?.get(req.agentId as AgentId)
        : undefined;
    const role = rosterMember?.role;
    const prefix = role !== undefined ? `[${role}] ` : "";

    const res = await this.conn.requestPermission({
      sessionId: this.sessionId,
      toolCall: withSwarmMeta(
        {
          toolCallId: crypto.randomUUID(),
          title: prefix + toolTitle(req.toolName, req.input),
          kind: toolKind(req.toolName),
          rawInput: req.input,
        },
        rosterMember !== undefined
          ? swarmMemberMeta(rosterMember, { topology: "coordinator" })
          : undefined,
      ),
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
    // Persist team-wide so later same-tool requests skip the prompt (Q2).
    if (outcome.optionId === "allow_always") {
      this.alwaysAllowed.add(req.toolName);
    }
    return { outcome: "allow" };
  }
}
