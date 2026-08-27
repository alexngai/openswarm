/**
 * parallel-recovery.ts — crash-recovery helpers for batch-spawn topologies
 * (peer-team, committee) — team crash-recovery T3b.
 *
 * fanout/pipeline adopted the TeamCheckpointStore directly because they own a
 * per-task/-stage dispatch loop. peer-team and committee instead spawn ALL
 * members in one `team.spawnAll(...)` batch and then await a CompletionRule
 * over the resulting handles. This module lets those topologies opt into the
 * same T1 (skip succeeded) + T2 (re-dispatch in-flight with a verify-then-
 * continue preamble and a per-unit session sidecar) recovery without rewriting
 * their completion logic:
 *
 *   1. `planParallelDispatch` decides, per member, whether to skip (a prior run
 *      recorded it `succeeded`) or (re)spawn it, applies the resume preamble +
 *      sidecar to in-flight members, and marks each (re)spawned member
 *      in-flight in the checkpoint.
 *   2. `makeResolvedHandle` synthesizes an already-resolved AgentHandle for a
 *      skipped member so the topology's existing CompletionRule logic
 *      (all / any / majority / deadline / until_signal) counts it as complete
 *      with ZERO changes — index alignment with `spec.members` is preserved.
 *   3. `recordTerminal` records a (re)spawned member's terminal outcome so the
 *      next restart can skip it (succeeded) or re-run it (non-success).
 *
 * Recovery is per-member; message durability (peer inboxes) is a separate
 * concern (T3a) — a re-dispatched member resumes its OWN engine session (so it
 * keeps the messages it had already received), but messages sent to it after
 * the crash are not replayed until inbox persistence lands.
 */

import type { AgentId, SessionId } from "../../core/types.js";
import type { AgentHandle, AgentResult } from "../host.js";
import type { LaneEvent } from "../events.js";
import type { MemberSpec } from "../team-spec.js";
import type { UnitStatus } from "../team-checkpoint.js";
import type { TopologyContext } from "../topologies-types.js";

/**
 * Prepended to a member's prompt when re-dispatching a unit that was mid-flight
 * when the daemon crashed. Mirrors fanout's preamble; the worker also resumes
 * its prior engine session (per-unit sidecar), so this frames the resumed
 * conversation.
 */
export const RESUME_PREAMBLE =
  "[Resumed after interruption] The team was interrupted and restarted, and " +
  "you may have already partially completed this task. Before doing anything " +
  "else, verify the current state of your work (inspect files, git status, " +
  "and any outputs you already produced). Then continue from where you left " +
  "off — do not redo steps that are already complete. If the task is already " +
  "fully done, just report completion.\n\n---\n\n";

/** Per-member dispatch decision produced by {@link planParallelDispatch}. */
export interface MemberDispatchPlan {
  /** Stable checkpoint unit id (member.id, else positional `member-<idx>`). */
  readonly unitId: string;
  /** True when a prior run recorded this member `succeeded` → skip spawn. */
  readonly skip: boolean;
  /** Result to reuse (via {@link makeResolvedHandle}) when `skip` is true. */
  readonly skippedResult?: AgentResult;
  /** MemberSpec to spawn (preamble + sidecar applied) when `skip` is false. */
  readonly spawnSpec?: MemberSpec;
}

/**
 * Stable per-member checkpoint id. Uses the explicit member id when present,
 * else a positional id. Positional ids are safe across restarts because the
 * checkpoint's spec-hash guard invalidates the checkpoint if member order (or
 * any recovery-relevant field) changes.
 */
export function unitIdFor(member: MemberSpec, idx: number): string {
  return member.id ?? `member-${idx}`;
}

/**
 * Compute the per-member dispatch plan for a batch-spawn topology and, as a
 * side effect, mark every (re)spawned member in-flight in the checkpoint.
 *
 * `members` should already carry any topology-specific prompt augmentation
 * (e.g. peer-team's teammate list) — the resume preamble is layered on top.
 * When `ctx.checkpoint` is undefined this is a pure pass-through: every member
 * is planned as a fresh (non-skip) spawn with its prompt unchanged.
 */
export async function planParallelDispatch(
  members: readonly MemberSpec[],
  ctx: TopologyContext,
  teamName: string,
  scope: string,
): Promise<MemberDispatchPlan[]> {
  const plans: MemberDispatchPlan[] = [];
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    const unitId = unitIdFor(member, i);
    const checkpoint = ctx.checkpoint;

    const prior = checkpoint?.get(unitId);
    if (prior?.status === "succeeded") {
      plans.push({
        unitId,
        skip: true,
        skippedResult: {
          status: "success",
          output: prior.output ?? "",
          usage: { inputTokens: 0, outputTokens: 0 },
          wallClockMs: 0,
        },
      });
      ctx.host.emit({
        type: "team_note",
        payload: {
          teamName,
          scope,
          note: `member ${unitId} skipped (resumed from checkpoint)`,
        },
      });
      continue;
    }

    if (checkpoint === undefined) {
      plans.push({ unitId, skip: false, spawnSpec: member });
      continue;
    }

    const sidecar = checkpoint.sidecarPathFor(unitId);
    const priorInFlight = checkpoint.wasInFlight(unitId);
    const spawnSpec: MemberSpec = {
      ...member,
      sessionSidecarPath: sidecar,
      ...(priorInFlight !== undefined && {
        prompt: RESUME_PREAMBLE + member.prompt,
      }),
    };
    if (priorInFlight !== undefined) {
      ctx.host.emit({
        type: "team_note",
        payload: {
          teamName,
          scope,
          note: `member ${unitId} re-dispatched in-flight with verify-then-continue preamble (resuming engine session)`,
        },
      });
    }
    await checkpoint
      .markDispatched({
        id: unitId,
        dispatchedAt: Date.now(),
        sidecarPath: sidecar,
      })
      .catch(() => {});
    plans.push({ unitId, skip: false, spawnSpec });
  }
  return plans;
}

/** Map an AgentResult to the checkpoint's terminal UnitStatus. */
export function statusOf(result: AgentResult): UnitStatus {
  switch (result.status) {
    case "success":
      return "succeeded";
    case "timeout":
      return "timeout";
    case "killed":
      return "cancelled";
    default:
      return "failed";
  }
}

/**
 * Record a (re)spawned member's terminal outcome. Best-effort — a checkpoint
 * write failure must never fail the topology. Callers should await this after
 * the CompletionRule resolves (by then every spawned handle's `wait()` has
 * settled, including losers the rule killed), so writes flush before the
 * daemon closes the store.
 */
export async function recordTerminal(
  ctx: TopologyContext,
  unitId: string,
  agentId: AgentId,
  result: AgentResult,
): Promise<void> {
  if (ctx.checkpoint === undefined) return;
  await ctx.checkpoint
    .record({
      id: unitId,
      status: statusOf(result),
      agentId,
      completedAt: Date.now(),
      ...(result.status === "success" && { output: result.output }),
    })
    .catch(() => {});
}

/**
 * Synthesize an already-resolved AgentHandle for a skipped (previously
 * succeeded) member. Its `wait()` resolves immediately to the stored result so
 * the topology's CompletionRule counts it as complete; `kill()` and the
 * long-lived-only methods are no-ops / inert. `streamIdFor(agentId)` returns
 * undefined for this synthetic id, so stream-merge steps skip it.
 */
export function makeResolvedHandle(
  unitId: string,
  result: AgentResult,
): AgentHandle {
  const agentId = `resumed:${unitId}` as AgentId;
  return {
    agentId,
    sessionId: agentId as unknown as SessionId,
    wait: async () => result,
    kill: async () => {},
    events: async function* (): AsyncIterable<LaneEvent> {
      return;
    },
    runMore: async () => {
      throw new Error("resumed member handle does not support runMore()");
    },
    drain: async () => {},
  };
}
