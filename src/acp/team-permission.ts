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
  AskUserResponse,
} from "../swarm/host.js";
import type { AgentId } from "../core/types.js";
import type { MemberInfo } from "../swarm/team-session.js";
import { toolKind, toolTitle } from "./tool-kind.js";
import { swarmMemberMeta, withSwarmMeta } from "./swarm-meta.js";

type Roster = ReadonlyMap<AgentId, MemberInfo> | undefined;

type RouterConn = Pick<AgentSideConnection, "requestPermission" | "sessionUpdate">;

export class AcpPermissionRouter implements InteractionHandler {
  private conn?: RouterConn;
  private sessionId?: string;
  private rosterFn?: () => Roster;
  /** Tools the user chose "always allow" for — team-wide, connection lifetime. */
  private readonly alwaysAllowed = new Set<string>();
  /** Serialization chain: only one prompt is outstanding to the client at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * A member's open-ended `ask_user_question` parks here: its IPC call blocks on
   * `resolve` until the next ACP prompt answers it (Q1 blocked-on-human). The
   * worker's IPC has its own timeout backstop, so this can't hang forever.
   */
  private parked?: { resolve: (r: AskUserResponse) => void };
  /** Resolves once when a question parks; recreated after each park. */
  private parkPromise?: Promise<void>;
  private parkNotify?: () => void;

  setConn(conn: RouterConn): void {
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
    // escalations don't stack modals on the client (Q2).
    return this.enqueue(() => this.promptOnce(req));
  }

  /**
   * Route a member's `ask_user_question` to the client (docs/33 §9). Mapped to a
   * requestPermission prompt whose options are the answer choices (the selected
   * option's text is the answer). Multiple-choice only — ACP has no free-form
   * text input, so an open-ended question (no options) returns an error.
   * Serialized through the same queue as permissions so prompts don't stack.
   */
  async askUserQuestion(
    question: string,
    options?: readonly string[],
  ): Promise<AskUserResponse> {
    // Open-ended (no options): park it — the answer arrives on the next prompt
    // (Q1). Parking is long-lived, so it must NOT go through the serialization
    // queue (it would block every other prompt).
    if ((options ?? []).length === 0) return this.parkQuestion(question);
    return this.enqueue(() => this.askOnce(question, options));
  }

  /** True while an open-ended question is awaiting an answer. */
  hasParkedQuestion(): boolean {
    return this.parked !== undefined;
  }

  /** Resolves the parked question with `answer`; returns whether there was one. */
  answerParkedQuestion(answer: string): boolean {
    const p = this.parked;
    if (p === undefined) return false;
    this.parked = undefined;
    p.resolve({ status: "answered", answer });
    return true;
  }

  /** Resolve any parked question as cancelled (e.g. on session/cancel). */
  cancelParkedQuestion(): void {
    const p = this.parked;
    if (p === undefined) return;
    this.parked = undefined;
    p.resolve({ status: "cancelled" });
  }

  /** A promise that resolves the next time a question parks (shared, one-shot). */
  whenParked(): Promise<void> {
    if (this.parked !== undefined) return Promise.resolve();
    if (this.parkPromise === undefined) {
      this.parkPromise = new Promise<void>((resolve) => {
        this.parkNotify = resolve;
      });
    }
    return this.parkPromise;
  }

  private parkQuestion(question: string): Promise<AskUserResponse> {
    if (this.conn === undefined || this.sessionId === undefined) {
      return Promise.resolve({ status: "error", message: "no active ACP session" });
    }
    if (this.parked !== undefined) {
      return Promise.resolve({
        status: "error",
        message: "another question is already awaiting an answer",
      });
    }
    // Narrate the question so the user sees what to answer.
    void this.conn
      .sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\n❓ ${question}\n(reply with your answer in the next prompt)\n`,
          },
        },
      })
      .catch(() => {});
    return new Promise<AskUserResponse>((resolve) => {
      this.parked = { resolve };
      // Wake any prompt racing on whenParked().
      const notify = this.parkNotify;
      this.parkPromise = undefined;
      this.parkNotify = undefined;
      notify?.();
    });
  }

  private async askOnce(
    question: string,
    options?: readonly string[],
  ): Promise<AskUserResponse> {
    if (this.conn === undefined || this.sessionId === undefined) {
      return { status: "error", message: "no active ACP session" };
    }
    const opts = options ?? [];
    if (opts.length === 0) {
      return {
        status: "error",
        message:
          "open-ended questions aren't supported over ACP (no free-form input); provide options",
      };
    }
    const res = await this.conn.requestPermission({
      sessionId: this.sessionId,
      // kind omitted: this is a question, not a tool action.
      toolCall: { toolCallId: crypto.randomUUID(), title: question },
      options: [
        ...opts.map((name, i) => ({
          optionId: `opt:${i}`,
          name,
          kind: "allow_once" as const,
        })),
        { optionId: "__cancel", name: "Cancel", kind: "reject_once" as const },
      ],
    });
    const outcome = res.outcome;
    if (outcome.outcome === "cancelled" || outcome.optionId === "__cancel") {
      return { status: "cancelled" };
    }
    const m = /^opt:(\d+)$/.exec(outcome.optionId);
    if (m !== null) {
      const idx = Number.parseInt(m[1]!, 10);
      if (idx >= 0 && idx < opts.length) {
        return { status: "answered", answer: opts[idx]! };
      }
    }
    return { status: "cancelled" };
  }

  /** Serialize a client prompt behind any in-flight one. Failures don't break the chain. */
  private enqueue<T>(thunk: () => Promise<T>): Promise<T> {
    const run = this.queue.then(thunk);
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
