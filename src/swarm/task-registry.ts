/**
 * TaskRegistry — in-memory store for TaskRecords.
 *
 * Single-threaded (Node), all methods synchronous. No persistence (M1 scope).
 * ID generation uses `crypto.randomUUID()` for uniqueness guarantees.
 *
 * Pub/sub via a simple listener array (FIFO delivery). No external deps.
 */

import { randomUUID } from "node:crypto";
import type { TaskPacket, TaskRecord, TaskFilter, TaskStatus } from "./host.js";
import type { AgentId } from "../core/types.js";
import type { LaneEvent } from "./events.js";

/** Statuses from which a task never transitions again. */
const TERMINAL_STATUSES = ["succeeded", "failed", "stopped", "timeout"] as const;

export type TerminalTaskStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: TaskStatus): status is TerminalTaskStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners: Array<(event: LaneEvent) => void> = [];

  /**
   * Create a new TaskRecord. Auto-assigns `id` via `crypto.randomUUID()`.
   * Populates `createdAt` and `updatedAt` as `Date.now()`.
   * `scope` defaults to "swarm:default" — set by callers in a team context.
   */
  create(
    packet: Omit<TaskPacket, "id">,
    scope: string = "swarm:default",
  ): TaskRecord {
    const id = randomUUID();
    const now = Date.now();
    const record: TaskRecord = {
      ...packet,
      id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      scope,
    };
    this.records.set(id, record);
    return record;
  }

  /** Retrieve a TaskRecord by id. Returns `undefined` if not found. */
  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Claim the first unowned pending task in `scope`, as one indivisible step.
   *
   * The claim is written as a compare-and-swap against the record this loop
   * actually saw, rather than trusting that nothing moved: the test of
   * `status` and `owner` and the write that sets them are one operation, and a
   * record that changed underneath is skipped instead of overwritten. Today
   * that holds anyway, because nothing here awaits and Node runs this to
   * completion — but "correct as long as nobody adds an await" is a property
   * that quietly stops being true, and the loop reads as though it were merely
   * checking fields. Stating the precondition means a future async store
   * inherits a claim that fails cleanly instead of a lost update (docs/63
   * WP-06).
   *
   * Iteration order is insertion order so producers can rely on FIFO
   * semantics (the first task created is the first task pulled). When a
   * priority field is added to TaskRecord later, this method should sort
   * by priority desc + insertion order.
   */
  pullNext(scope: string, claimerId: AgentId): TaskRecord | null {
    for (const record of this.records.values()) {
      if (record.scope !== scope) continue;
      const claimed = this.claim(record.id, claimerId, record);
      if (claimed !== null) return claimed;
    }
    return null;
  }

  /**
   * Claim one task by id, but only if it is still exactly as `expected`.
   *
   * Returns the claimed record, or null when the precondition no longer holds
   * — which covers a task that is claimed, no longer pending, or gone. Null is
   * "somebody else got there", not an error: a losing claimant should look for
   * other work rather than fail.
   */
  claim(id: string, claimerId: AgentId, expected: TaskRecord): TaskRecord | null {
    const current = this.records.get(id);
    if (current === undefined) return null;
    // Identity, not deep equality: every mutation here replaces the record
    // object, so a changed object is a changed record, and comparing fields
    // would miss a change that happened to restore them.
    if (current !== expected) return null;
    if (current.status !== "pending") return null;
    if (current.owner !== undefined) return null;

    const claimed: TaskRecord = {
      ...current,
      owner: claimerId,
      status: "running",
      updatedAt: Date.now(),
    };
    this.records.set(id, claimed);
    return claimed;
  }

  /**
   * List all TaskRecords, optionally filtered by `status`, `owner`,
   * or `parentTaskId` (from `task.context.parentTaskId`).
   */
  list(filter?: TaskFilter): readonly TaskRecord[] {
    const all = Array.from(this.records.values());
    if (!filter) return all;

    return all.filter((r) => {
      if (filter.status !== undefined && r.status !== filter.status) return false;
      if (filter.owner !== undefined && r.owner !== filter.owner) return false;
      if (filter.parentTaskId !== undefined) {
        if (r.context?.parentTaskId !== filter.parentTaskId) return false;
      }
      if (filter.scope !== undefined && r.scope !== filter.scope) return false;
      return true;
    });
  }

  /**
   * Patch selected mutable fields on an existing TaskRecord.
   * Updates `updatedAt` to `Date.now()`. Throws if `id` is unknown.
   *
   * A task that has reached a terminal status will not change status again.
   * The first terminal result is the one that happened, and a later one is
   * either a duplicate report or a disagreement — in both cases overwriting is
   * the wrong answer, because it makes a task that failed look successful
   * depending on which report arrived last. Non-status patches are still
   * accepted after a terminal transition, since a trailing chunk of output is
   * ordinary and says nothing about the outcome.
   */
  update(
    id: string,
    patch: Partial<Pick<TaskRecord, "status" | "owner" | "output" | "error">>,
  ): void {
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error(`TaskRegistry.update: unknown task id "${id}"`);
    }
    if (
      patch.status !== undefined &&
      patch.status !== existing.status &&
      isTerminal(existing.status)
    ) {
      throw new Error(
        `TaskRegistry.update: task "${id}" is already ${existing.status}; ` +
          `refusing to change it to ${patch.status}`,
      );
    }
    const updated: TaskRecord = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    this.records.set(id, updated);
  }

  /**
   * Record a task's terminal outcome and its result in one write.
   *
   * Status and payload go together because separately they can disagree: a task
   * marked succeeded before its output arrives is briefly a success with
   * nothing to show, and readers that sample in that window — the UI, the
   * results file, a parent deciding whether to retry — see a finished task with
   * no result and have no way to tell that from one that genuinely produced
   * nothing.
   *
   * Returns false when the task was already terminal, so a duplicate report is
   * a no-op the caller can see rather than an exception it has to expect.
   */
  resolve(
    id: string,
    outcome: {
      readonly status: TerminalTaskStatus;
      readonly output?: string;
      readonly error?: string;
      readonly stoppedBy?: string;
    },
  ): boolean {
    const existing = this.records.get(id);
    if (existing === undefined) {
      throw new Error(`TaskRegistry.resolve: unknown task id "${id}"`);
    }
    if (isTerminal(existing.status)) return false;

    this.records.set(id, {
      ...existing,
      status: outcome.status,
      updatedAt: Date.now(),
      ...(outcome.output !== undefined && { output: outcome.output }),
      ...(outcome.error !== undefined && { error: outcome.error }),
      ...(outcome.stoppedBy !== undefined && { stoppedBy: outcome.stoppedBy }),
    });
    return true;
  }

  /**
   * Transition a task to "stopped". When `by` is supplied, persists it on
   * `TaskRecord.stoppedBy` so the orchestrator can surface it in the cancelled
   * results.jsonl line. Throws if `id` is unknown.
   *
   * Stopping an already-terminal task is a no-op rather than an overwrite: a
   * cancellation that arrives after a task finished did not cancel anything,
   * and recording it as stopped would discard the result it actually produced.
   * This is what the doc comment here has always claimed and the body did not
   * do — it rewrote the status unconditionally, so a late stop turned a
   * completed task into a cancelled one.
   */
  stop(id: string, by?: string): void {
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error(`TaskRegistry.stop: unknown task id "${id}"`);
    }
    this.resolve(id, { status: "stopped", ...(by !== undefined && { stoppedBy: by }) });
  }

  /**
   * Append a chunk of text to an existing task's output field.
   * Silently no-ops if the taskId is unknown (task may have been stopped).
   * Do NOT confuse with `update(id, patch)` which REPLACES output.
   */
  appendOutput(id: string, chunk: string): void {
    const record = this.records.get(id);
    if (record === undefined) return; // silently ignore — task may have been stopped
    this.records.set(id, {
      ...record,
      output: (record.output ?? "") + chunk,
    });
  }

  /**
   * Emit a LaneEvent to all registered listeners in FIFO order.
   * Used by the orchestrator's results emitter to fan out events.
   */
  emit(event: LaneEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Register a listener for LaneEvents emitted via `emit()`.
   * Returns an unsubscribe function; calling it removes only this listener.
   */
  onEvent(listener: (event: LaneEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
    };
  }
}
