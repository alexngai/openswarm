/**
 * Team lane translator (collapsed, B0) — LaneEvent bus -> ACP session/update.
 *
 * Worker engine events arrive on the bus with their real type (after the
 * worker-entry forwarding fix) and `payload` = the raw NormalizedEvent. We
 * unwrap and feed them through the shared emitter, attributing each to its
 * member via the roster: the lead (role "lead") narrates; other members'
 * text is suppressed (collapse, docs/31 Q3); every member's tool calls surface
 * `[role]`-prefixed with agentId-namespaced ids. Member/task lifecycle events
 * drive a roster-derived `plan` (the team board). See docs/archive/33 §5.
 *
 * Events are serialized through an internal promise chain so notifications keep
 * wire order despite async `sessionUpdate`. `drain()` awaits the backlog.
 */

import type {
  AgentSideConnection,
  PlanEntry,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentId, NormalizedEvent } from "../core/types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { MemberInfo } from "../swarm/team-session.js";
import { emitNormalizedEvent } from "./normalized-translate.js";
import { ToolInputAccumulator } from "../core/tool-input.js";
import { swarmMemberMeta, withSwarmMeta } from "./swarm-meta.js";

const WORKER_ENGINE_TYPES = new Set<string>([
  "text_delta",
  "tool_use_start",
  "tool_use_input",
  "tool_use_end",
  "tool_result",
  "message_stop",
  "error",
]);

const PLAN_TRIGGER_TYPES = new Set<string>([
  "worker_spawned",
  "worker_ready",
  "worker_exited",
  "worker_crashed",
  "worker_idle",
  "worker_drained",
  "worker_lifecycle_changed",
  "task_created",
  "task_updated",
  "task_completed",
  "task_failed",
  "task_stopped",
]);

export interface LaneTranslatorDeps {
  /** Current team roster (agentId -> member); undefined before the team forms. */
  getRoster(): ReadonlyMap<AgentId, MemberInfo> | undefined;
  /**
   * Baseline member-text policy (Q3, B1.2). "collapse" (default) suppresses
   * non-lead text — only the lead narrates. "interleave" streams non-lead text
   * too, prefixing each member's contiguous run with `**[role]**:` so the
   * single stream reads as speaker-labeled chat. Rich clients lane by `_meta`
   * regardless; this only governs the baseline text stream.
   */
  memberText?: "collapse" | "interleave";
}

export interface LaneTranslator {
  /** Enqueue a lane event; handled in order on an internal chain. */
  onLaneEvent(event: LaneEvent): void;
  /** Await all enqueued work (call before resolving the prompt). */
  drain(): Promise<void>;
}

type PlanStatus = "pending" | "in_progress" | "completed";

function mapMemberState(s: MemberInfo["state"]): PlanStatus {
  switch (s) {
    case "spawning":
      return "pending";
    case "running":
      return "in_progress";
    default:
      return "completed"; // idle | finished | failed
  }
}

/**
 * The worker's agentId carried by a lifecycle lane event. `worker_spawned` and
 * `worker_exited` are host-emitted (LaneEvent.agentId = orchestrator), so the
 * child id lives in the payload; `worker_idle`/`worker_drained` already carry
 * the child as LaneEvent.agentId.
 */
function lifecycleChildId(event: LaneEvent): AgentId | undefined {
  const p = event.payload as Record<string, unknown> | undefined;
  switch (event.type) {
    case "worker_spawned":
      return (p?.childAgentId as AgentId | undefined) ?? undefined;
    case "worker_exited":
      return (p?.agentId as AgentId | undefined) ?? undefined;
    default:
      return event.agentId;
  }
}

/** Map a worker lifecycle lane event to a plan status, or undefined to ignore. */
function lifecycleStatus(event: LaneEvent): PlanStatus | undefined {
  switch (event.type) {
    case "worker_spawned":
    case "worker_ready":
      return "in_progress";
    case "worker_idle":
    case "worker_drained":
    case "worker_exited":
    case "worker_crashed":
      return "completed";
    case "worker_lifecycle_changed": {
      const to = (event.payload as { to?: string } | undefined)?.to;
      if (to === "prompt_accepted" || to === "running" || to === "blocked")
        return "in_progress";
      if (to === "idle" || to === "drained" || to === "finished" || to === "failed")
        return "completed";
      return undefined;
    }
    default:
      return undefined;
  }
}

function isNormalizedEvent(p: unknown): p is NormalizedEvent {
  return (
    p !== null &&
    typeof p === "object" &&
    typeof (p as { type?: unknown }).type === "string"
  );
}

export function makeLaneTranslator(
  conn: Pick<AgentSideConnection, "sessionUpdate">,
  sessionId: string,
  deps: LaneTranslatorDeps,
): LaneTranslator {
  const open = new ToolInputAccumulator<string>();
  let chain = Promise.resolve();
  let lastPlanKey = "";
  // The coordinator's root emits first; treat the first member seen as the lead
  // when the roster isn't yet available (role lookup wins when it is).
  let firstSeen: AgentId | undefined;
  // Interleave mode: the member whose text run is currently streaming, so we
  // emit the `**[role]**:` prefix once per run rather than per delta.
  let lastTextSpeaker: AgentId | undefined;
  // Per-member plan status, driven by worker lifecycle + engine activity.
  // MemberInfo.state is fixed at "running" by the orchestrator (never updated),
  // so the board would otherwise be stuck at in_progress forever (B1). This map
  // is the source of truth; roster state is only the fallback for members we
  // haven't observed yet.
  const memberStatus = new Map<AgentId, PlanStatus>();

  const send = (update: SessionUpdate): Promise<void> =>
    conn.sessionUpdate({ sessionId, update });

  /** Set a member's status; returns true if it changed. */
  function applyStatus(id: AgentId | undefined, status: PlanStatus): boolean {
    if (id === undefined) return false;
    if (memberStatus.get(id) === status) return false;
    memberStatus.set(id, status);
    return true;
  }

  async function emitPlan(): Promise<void> {
    const roster = deps.getRoster();
    if (roster === undefined || roster.size === 0) return;
    const entries: PlanEntry[] = [...roster.entries()].map(([agentId, m]) =>
      withSwarmMeta(
        {
          content: m.role,
          priority: "medium" as const,
          status: memberStatus.get(agentId) ?? mapMemberState(m.state),
        },
        swarmMemberMeta(m, { topology: "coordinator" }),
      ),
    );
    const key = entries.map((e) => `${e.content}:${e.status}`).join("|");
    if (key === lastPlanKey) return; // dedupe identical plans
    lastPlanKey = key;
    await send({ sessionUpdate: "plan", entries });
  }

  async function handle(event: LaneEvent): Promise<void> {
    if (WORKER_ENGINE_TYPES.has(event.type)) {
      if (!isNormalizedEvent(event.payload)) return;
      if (firstSeen === undefined) firstSeen = event.agentId;
      const rosterMember = deps.getRoster()?.get(event.agentId);
      const role = rosterMember?.role;
      // Lead = roster role "lead" when known, else the first member to speak.
      const isLead =
        role !== undefined ? role === "lead" : event.agentId === firstSeen;
      const interleave = deps.memberText === "interleave";
      const meta =
        rosterMember !== undefined
          ? swarmMemberMeta(rosterMember, { topology: "coordinator" })
          : undefined;
      const payload = event.payload;

      // Interleave: prefix a non-lead member's contiguous text run with
      // `**[role]**:` (once, on speaker change) so the collapsed stream reads as
      // speaker-labeled chat (Q3). The lead stays the unprefixed primary voice.
      if (
        interleave &&
        !isLead &&
        role !== undefined &&
        payload.type === "text_delta" &&
        lastTextSpeaker !== event.agentId
      ) {
        await send(
          withSwarmMeta(
            {
              sessionUpdate: "agent_message_chunk" as const,
              content: { type: "text" as const, text: `\n**[${role}]**: ` },
            },
            meta,
          ),
        );
      }
      if (payload.type === "text_delta") lastTextSpeaker = event.agentId;

      await emitNormalizedEvent(payload, {
        send,
        open,
        idPrefix: `${event.agentId}:`,
        ...(role !== undefined ? { titlePrefix: `[${role}] ` } : {}),
        // Collapse (default): only the lead narrates. Interleave: all members'
        // text streams (prefixed above).
        suppressText: !isLead && !interleave,
        // The team plan comes from the roster, not member todo_write.
        planFromTodos: false,
        // B1.1: enrich every member update with swarm meta.
        ...(meta !== undefined ? { meta } : {}),
      });

      // A turn-ending message_stop closes the current text run so the next run
      // re-prefixes its speaker.
      if (payload.type === "message_stop") lastTextSpeaker = undefined;

      // Engine activity (anything but a turn-ending message_stop) means the
      // member is working — flip it back to in_progress (handles 2nd-turn
      // reactivation after a member went idle). Re-emit the board if changed.
      if (event.type !== "message_stop") {
        if (applyStatus(event.agentId, "in_progress")) await emitPlan();
      }
      return;
    }
    if (PLAN_TRIGGER_TYPES.has(event.type)) {
      const status = lifecycleStatus(event);
      if (status !== undefined) applyStatus(lifecycleChildId(event), status);
      await emitPlan();
    }
  }

  return {
    onLaneEvent(event: LaneEvent): void {
      chain = chain.then(() => handle(event)).catch(() => {
        // A single bad event must not wedge the stream.
      });
    },
    drain: () => chain,
  };
}
