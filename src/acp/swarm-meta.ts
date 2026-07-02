/**
 * `_meta.swarm` v1 — versioned swarm enrichment for ACP (docs/31 §4, docs/archive/34).
 *
 * Every member-attributed `session/update`, `plan` entry, and `request_permission`
 * carries this *additively*, beside the standard fields the baseline already
 * emits. The hard invariant (docs/31 §6): stripping `_meta` must leave a valid,
 * trust-coherent single-agent session — member identity always also lives in a
 * standard field (`toolCall.title`), never in `_meta` alone.
 *
 * This module owns the shape and the attach helper so the agent never hand-rolls
 * `_meta`. Placement is the *inner update object* (ContentChunk / ToolCall /
 * ToolCallUpdate / PlanEntry all expose `_meta` in the ACP SDK), matching
 * `update._meta.swarm` / `entry._meta.swarm` / `toolCall._meta.swarm`.
 */

import type { MemberInfo } from "../swarm/team-session.js";

export const SWARM_META_VERSION = 1 as const;

export interface SwarmMemberMeta {
  /** Stable member id within the team (MemberInfo.memberId). */
  readonly id: string;
  /** Human label, e.g. "architect". */
  readonly name: string;
  /** "lead" | "worker" | … */
  readonly role?: string;
  /** Absolute worktree path, if git-cascade is active. */
  readonly worktree?: string;
  /** git-cascade streamId, if any. */
  readonly stream?: string;
}

export interface SwarmTaskMeta {
  readonly id: string;
  readonly parentId?: string;
  readonly dependsOn?: readonly string[];
  /** The active topology for this session, e.g. "coordinator". */
  readonly topology?: string;
}

/** Stripping this must leave a valid single-agent session. */
export interface SwarmMeta {
  readonly v: typeof SWARM_META_VERSION;
  /** The member this update/permission/voice belongs to. Absent ⇒ orchestrator. */
  readonly member?: SwarmMemberMeta;
  /** Team/task context for board rendering + dependency edges. */
  readonly task?: SwarmTaskMeta;
}

export interface SwarmMetaContext {
  /** The active topology, surfaced under task.topology. */
  readonly topology?: string;
  /** The member's task id, if known to the caller. */
  readonly taskId?: string;
  readonly parentTaskId?: string;
  readonly dependsOn?: readonly string[];
}

/**
 * Build `SwarmMeta` for a roster member. `task` is emitted only when there is a
 * real task id (the schema requires `task.id`); otherwise it's omitted. worktree
 * /stream populate only under git-cascade — omitted (never empty strings) in v1.
 */
export function swarmMemberMeta(
  member: MemberInfo,
  ctx: SwarmMetaContext = {},
): SwarmMeta {
  const memberMeta: SwarmMemberMeta = {
    id: member.memberId,
    name: member.role,
    ...(member.role !== undefined && { role: member.role }),
  };
  const task: SwarmTaskMeta | undefined =
    ctx.taskId !== undefined
      ? {
          id: ctx.taskId,
          ...(ctx.parentTaskId !== undefined && { parentId: ctx.parentTaskId }),
          ...(ctx.dependsOn !== undefined && ctx.dependsOn.length > 0 && {
            dependsOn: [...ctx.dependsOn],
          }),
          ...(ctx.topology !== undefined && { topology: ctx.topology }),
        }
      : undefined;
  return {
    v: SWARM_META_VERSION,
    member: memberMeta,
    ...(task !== undefined && { task }),
  };
}

/**
 * Attach `_meta.swarm` to an update/entry/toolCall, merging with any existing
 * `_meta`. A `undefined` meta is a no-op (returns the object unchanged), so the
 * baseline path stays byte-identical.
 */
export function withSwarmMeta<T extends object>(
  obj: T,
  meta: SwarmMeta | undefined,
): T {
  if (meta === undefined) return obj;
  const prev = (obj as { _meta?: Record<string, unknown> })._meta;
  return { ...obj, _meta: { ...prev, swarm: meta } };
}
