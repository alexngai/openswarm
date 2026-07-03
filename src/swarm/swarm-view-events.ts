/**
 * swarm-view-events.ts — translate swarm lane events into the three
 * multi-agent `NormalizedEvent`s the interactive REPL renders in its
 * AgentTree (Ctrl+A) and TaskBoard (Ctrl+T) views.
 *
 * Background (GitHub #15): the REPL views, their reducer actions
 * (`agent-spawned` / `agent-status` / `task-update`), the engine-event
 * translators in `src/ui/repl-solid/app.tsx`, and the `agent_spawned` /
 * `agent_status` / `task_update` NormalizedEvent decls in `src/core/types.ts`
 * all shipped — but nothing in production ever EMITTED those events, so the
 * views were dead scaffolding. This module is the missing producer.
 *
 * It observes a StandaloneHost's lane-event bus (the orchestrator's view of
 * every member) and maps the swarm member lifecycle onto the view events:
 *
 *   worker_spawned            -> agent_spawned(spawning) + task_update(active)
 *   worker_lifecycle_changed  -> agent_status(<mapped phase>)
 *   forwarded child tool_use  -> agent_status(running, toolCount++)
 *   forwarded child msg_stop  -> agent_status(<phase>, tokenUsage += usage)
 *   worker_exited             -> agent_status(done|failed) + task_update(done|failed)
 *   task_created              -> task_update(pending)   (GitHub #23, real emission)
 *   task_updated              -> task_update(<mapped>)  (GitHub #23, real emission)
 *   task_completed/failed     -> task_update(done|failed)(GitHub #23, real emission)
 *
 * The worker_spawned/worker_exited task synthesis is retained (the TaskBoard
 * reducer keys on taskId, so real + synthesized updates converge idempotently);
 * the real task_* path is what drives the board for detached daemon teams whose
 * events.jsonl the REPL attach path (GitHub #23) replays.
 *
 * The translator is stateful (it tracks per-member phase + metrics + the
 * child→task mapping needed to finalize a task on exit) but has no I/O, so it
 * unit-tests directly against synthetic LaneEvents. `subscribeSwarmViewEvents`
 * wires it onto a live host.
 */

import type {
  AgentId,
  AgentPhase,
  NormalizedEvent,
  TaskStatus,
  Usage,
} from "../core/types.js";
import type { LaneEvent } from "./events.js";
import type { WorkerLifecycleState } from "./worker-lifecycle.js";
import type { StandaloneHost } from "./standalone-host.js";

/** Map a worker lifecycle state to the coarse phase the AgentTree renders. */
export function lifecycleToPhase(state: WorkerLifecycleState): AgentPhase {
  switch (state) {
    case "spawning":
    case "trust_required":
    case "ready_for_prompt":
      return "spawning";
    case "prompt_accepted":
    case "running":
    case "blocked":
      return "running";
    case "idle":
    case "draining":
    case "drained":
      return "idle";
    case "finished":
      return "done";
    case "failed":
      return "failed";
  }
}

interface MemberView {
  phase: AgentPhase;
  toolCount: number;
  tokenUsage: number;
  taskId: string | undefined;
  taskTitle: string;
}

/** Tracked task, populated from real `task_*` lane events (GitHub #23). */
interface TaskView {
  title: string;
  assignee: string | undefined;
}

/**
 * Map a registry TaskStatus (host.ts: pending/running/succeeded/failed/
 * stopped/timeout) onto the coarse TaskStatus the TaskBoard renders
 * (pending/active/done/failed). Unknown values fall back to "active".
 */
function mapTaskStatus(status: string | undefined): TaskStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "succeeded":
      return "done";
    case "failed":
    case "stopped":
    case "timeout":
      return "failed";
    case "running":
    default:
      return "active";
  }
}

export interface SwarmViewTranslatorOptions {
  /**
   * The orchestrator's own agentId. Members spawned directly by the
   * orchestrator render as tree roots (parentId omitted); only members spawned
   * by another member carry a parentId. Without this the whole tree would hang
   * off the orchestrator id, which is not itself a node — buildTree would then
   * render nothing (agent-tree.tsx roots come from `parentId == null`).
   */
  readonly orchestratorId?: AgentId;
  /**
   * Resolve a human-readable task title from its id (typically
   * `host.task.get(id)?.prompt`). Falls back to the member role, then the
   * short task id.
   */
  readonly resolveTaskTitle?: (taskId: string) => string | undefined;
}

/**
 * Stateful translator from a StandaloneHost lane-event stream to REPL view
 * NormalizedEvents. One instance per host subscription.
 */
export class SwarmViewTranslator {
  private readonly members = new Map<AgentId, MemberView>();
  /**
   * Tasks tracked from real `task_*` lane events (GitHub #23). Persists the
   * title (from `task_created`) and assignee so terminal `task_completed`/
   * `task_failed` events can carry them without re-resolving.
   */
  private readonly tasks = new Map<string, TaskView>();
  private readonly orchestratorId?: AgentId;
  private readonly resolveTaskTitle?: (taskId: string) => string | undefined;

  constructor(opts: SwarmViewTranslatorOptions = {}) {
    this.orchestratorId = opts.orchestratorId;
    this.resolveTaskTitle = opts.resolveTaskTitle;
  }

  /** Translate one lane event into zero or more view NormalizedEvents. */
  onLaneEvent(evt: LaneEvent): NormalizedEvent[] {
    switch (evt.type) {
      case "worker_spawned":
        return this.onWorkerSpawned(evt);
      case "worker_lifecycle_changed":
        return this.onLifecycleChanged(evt);
      case "worker_exited":
        return this.onWorkerExited(evt);
      case "tool_use_start":
        return this.onToolUseStart(evt);
      case "message_stop":
        return this.onMessageStop(evt);
      // GitHub #23 — real task lifecycle emitted by the spawn path (and
      // recorded to the daemon's events.jsonl, so the attach path sees them).
      case "task_created":
        return this.onTaskCreated(evt);
      case "task_updated":
        return this.onTaskUpdated(evt);
      case "task_completed":
        return this.onTaskTerminal(evt, "done");
      case "task_failed":
      case "task_stopped":
        return this.onTaskTerminal(evt, "failed");
      default:
        return [];
    }
  }

  private onWorkerSpawned(evt: LaneEvent): NormalizedEvent[] {
    const p = (evt.payload ?? {}) as {
      childAgentId?: string;
      parentAgentId?: string;
      role?: string;
      taskId?: string;
    };
    const agentId = p.childAgentId;
    if (agentId === undefined) return [];
    const role = p.role ?? "worker";
    const taskTitle =
      (p.taskId !== undefined ? this.resolveTaskTitle?.(p.taskId) : undefined) ??
      role ??
      shortId(p.taskId ?? agentId);
    this.members.set(agentId as AgentId, {
      phase: "spawning",
      toolCount: 0,
      tokenUsage: 0,
      taskId: p.taskId,
      taskTitle,
    });
    const parentId = this.resolveParent(p.parentAgentId);
    const out: NormalizedEvent[] = [
      {
        type: "agent_spawned",
        agentId,
        name: role,
        role,
        ...(parentId !== undefined ? { parentId } : {}),
      },
    ];
    if (p.taskId !== undefined) {
      out.push({
        type: "task_update",
        taskId: p.taskId,
        title: taskTitle,
        status: "active",
        assignee: agentId,
      });
    }
    return out;
  }

  private onLifecycleChanged(evt: LaneEvent): NormalizedEvent[] {
    // The orchestrator's own lifecycle transitions are not a swarm member.
    if (this.orchestratorId !== undefined && evt.agentId === this.orchestratorId) {
      return [];
    }
    const member = this.members.get(evt.agentId);
    if (member === undefined) return [];
    const to = (evt.payload as { to?: WorkerLifecycleState } | undefined)?.to;
    if (to === undefined) return [];
    member.phase = lifecycleToPhase(to);
    return [this.statusEvent(evt.agentId, member)];
  }

  private onWorkerExited(evt: LaneEvent): NormalizedEvent[] {
    const p = (evt.payload ?? {}) as { agentId?: string; exitCode?: number | null };
    const agentId = (p.agentId ?? evt.agentId) as AgentId;
    const member = this.members.get(agentId);
    if (member === undefined) return [];
    const ok = p.exitCode === 0;
    member.phase = ok ? "done" : "failed";
    const out: NormalizedEvent[] = [this.statusEvent(agentId, member)];
    if (member.taskId !== undefined) {
      out.push({
        type: "task_update",
        taskId: member.taskId,
        title: member.taskTitle,
        status: ok ? "done" : "failed",
        assignee: agentId,
      });
    }
    return out;
  }

  private onToolUseStart(evt: LaneEvent): NormalizedEvent[] {
    const member = this.members.get(evt.agentId);
    if (member === undefined) return [];
    member.toolCount += 1;
    // Any tool activity means the member is actively working.
    if (member.phase === "spawning") member.phase = "running";
    return [this.statusEvent(evt.agentId, member)];
  }

  private onMessageStop(evt: LaneEvent): NormalizedEvent[] {
    const member = this.members.get(evt.agentId);
    if (member === undefined) return [];
    const usage = (evt.payload as { usage?: Usage } | undefined)?.usage;
    if (usage !== undefined) {
      member.tokenUsage += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
    return [this.statusEvent(evt.agentId, member)];
  }

  private onTaskCreated(evt: LaneEvent): NormalizedEvent[] {
    const p = (evt.payload ?? {}) as { taskId?: string; prompt?: string };
    if (p.taskId === undefined) return [];
    const title = this.taskTitle(p.taskId, p.prompt);
    this.tasks.set(p.taskId, { title, assignee: undefined });
    return [{ type: "task_update", taskId: p.taskId, title, status: "pending" }];
  }

  private onTaskUpdated(evt: LaneEvent): NormalizedEvent[] {
    const p = (evt.payload ?? {}) as {
      taskId?: string;
      patch?: { status?: string; owner?: string };
    };
    if (p.taskId === undefined) return [];
    const task = this.tasks.get(p.taskId) ?? {
      title: this.taskTitle(p.taskId, undefined),
      assignee: undefined,
    };
    if (p.patch?.owner !== undefined) task.assignee = p.patch.owner;
    this.tasks.set(p.taskId, task);
    return [this.taskEvent(p.taskId, task, mapTaskStatus(p.patch?.status))];
  }

  private onTaskTerminal(evt: LaneEvent, status: TaskStatus): NormalizedEvent[] {
    const p = (evt.payload ?? {}) as { taskId?: string };
    if (p.taskId === undefined) return [];
    const task = this.tasks.get(p.taskId) ?? {
      title: this.taskTitle(p.taskId, undefined),
      assignee: undefined,
    };
    return [this.taskEvent(p.taskId, task, status)];
  }

  private taskEvent(
    taskId: string,
    task: TaskView,
    status: TaskStatus,
  ): NormalizedEvent {
    return {
      type: "task_update",
      taskId,
      title: task.title,
      status,
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
    };
  }

  /** Best task title: explicit prompt → resolver → short id. */
  private taskTitle(taskId: string, prompt: string | undefined): string {
    return (
      (prompt !== undefined && prompt.length > 0 ? prompt : undefined) ??
      this.resolveTaskTitle?.(taskId) ??
      shortId(taskId)
    );
  }

  private statusEvent(agentId: AgentId, member: MemberView): NormalizedEvent {
    return {
      type: "agent_status",
      agentId,
      phase: member.phase,
      toolCount: member.toolCount,
      tokenUsage: member.tokenUsage,
    };
  }

  /** Members spawned by the orchestrator render as roots (no parentId). */
  private resolveParent(parentAgentId: string | undefined): string | undefined {
    if (parentAgentId === undefined) return undefined;
    if (this.orchestratorId !== undefined && parentAgentId === this.orchestratorId) {
      return undefined;
    }
    // Only carry a parentId when the parent is itself a tracked member;
    // otherwise the tree node would be orphaned and never render.
    return this.members.has(parentAgentId as AgentId) ? parentAgentId : undefined;
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Subscribe a translator to a live StandaloneHost, forwarding every produced
 * view NormalizedEvent to `sink`. Returns an unsubscribe function.
 *
 * The task-title resolver defaults to the host's task registry, so the
 * TaskBoard shows the sub-agent prompt rather than an opaque id.
 */
export function subscribeSwarmViewEvents(
  host: StandaloneHost,
  sink: (evt: NormalizedEvent) => void,
): () => void {
  const translator = new SwarmViewTranslator({
    orchestratorId: host.agentId,
    // host.task.get is async; peekTaskTitle reads the synchronous in-memory
    // registry so the TaskBoard can label a member's task by its prompt the
    // instant it spawns.
    resolveTaskTitle: (taskId) => host.peekTaskTitle(taskId),
  });
  return host.onLaneEvent((evt) => {
    for (const out of translator.onLaneEvent(evt)) sink(out);
  });
}
