/**
 * Team lane translator (collapsed, B0) — LaneEvent bus -> ACP session/update.
 *
 * Worker engine events arrive on the bus with their real type (after the
 * worker-entry forwarding fix) and `payload` = the raw NormalizedEvent. We
 * unwrap and feed them through the shared emitter, attributing each to its
 * member via the roster: the lead (role "lead") narrates; other members'
 * text is suppressed (collapse, docs/31 Q3); every member's tool calls surface
 * `[role]`-prefixed with agentId-namespaced ids. Member/task lifecycle events
 * drive a roster-derived `plan` (the team board). See docs/33 §5.
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
import { emitNormalizedEvent, type OpenTool } from "./normalized-translate.js";

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
}

export interface LaneTranslator {
  /** Enqueue a lane event; handled in order on an internal chain. */
  onLaneEvent(event: LaneEvent): void;
  /** Await all enqueued work (call before resolving the prompt). */
  drain(): Promise<void>;
}

function mapMemberState(
  s: MemberInfo["state"],
): "pending" | "in_progress" | "completed" {
  switch (s) {
    case "spawning":
      return "pending";
    case "running":
      return "in_progress";
    default:
      return "completed"; // idle | finished | failed
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
  const open = new Map<string, OpenTool>();
  let chain = Promise.resolve();
  let lastPlanKey = "";

  const send = (update: SessionUpdate): Promise<void> =>
    conn.sessionUpdate({ sessionId, update });

  async function emitPlan(): Promise<void> {
    const roster = deps.getRoster();
    if (roster === undefined || roster.size === 0) return;
    const entries: PlanEntry[] = [...roster.values()].map((m) => ({
      content: m.role,
      priority: "medium" as const,
      status: mapMemberState(m.state),
    }));
    const key = entries.map((e) => `${e.content}:${e.status}`).join("|");
    if (key === lastPlanKey) return; // dedupe identical plans
    lastPlanKey = key;
    await send({ sessionUpdate: "plan", entries });
  }

  async function handle(event: LaneEvent): Promise<void> {
    if (WORKER_ENGINE_TYPES.has(event.type)) {
      if (!isNormalizedEvent(event.payload)) return;
      const role = deps.getRoster()?.get(event.agentId)?.role;
      await emitNormalizedEvent(event.payload, {
        send,
        open,
        idPrefix: `${event.agentId}:`,
        ...(role !== undefined ? { titlePrefix: `[${role}] ` } : {}),
        // Collapse: only the lead narrates; other members' text is suppressed.
        suppressText: role !== "lead",
        // The team plan comes from the roster, not member todo_write.
        planFromTodos: false,
      });
      return;
    }
    if (PLAN_TRIGGER_TYPES.has(event.type)) {
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
