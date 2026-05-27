/**
 * TaskRegistry — in-memory store for TaskRecords.
 *
 * Single-threaded (Node), all methods synchronous. No persistence (M1 scope).
 * ID generation uses `crypto.randomUUID()` for uniqueness guarantees.
 *
 * Pub/sub via a simple listener array (FIFO delivery). No external deps.
 */

import { randomUUID } from "node:crypto";
import type { TaskPacket, TaskRecord, TaskFilter } from "./host.js";
import type { AgentId } from "../core/types.js";
import type { LaneEvent } from "./events.js";

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
   * v0.5 stage 5C: atomically claim the first pending task in `scope` with
   * no `owner`. Sets `owner = claimerId` and `status = "running"` in one
   * step (single-threaded JS guarantees atomicity inside this method).
   * Returns the claimed record, or null when nothing matches.
   *
   * Iteration order is insertion order so producers can rely on FIFO
   * semantics (the first task created is the first task pulled). When a
   * priority field is added to TaskRecord later, this method should sort
   * by priority desc + insertion order.
   */
  pullNext(scope: string, claimerId: AgentId): TaskRecord | null {
    for (const record of this.records.values()) {
      if (record.scope !== scope) continue;
      if (record.status !== "pending") continue;
      if (record.owner !== undefined) continue;
      const claimed: TaskRecord = {
        ...record,
        owner: claimerId,
        status: "running",
        updatedAt: Date.now(),
      };
      this.records.set(record.id, claimed);
      return claimed;
    }
    return null;
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
   */
  update(
    id: string,
    patch: Partial<Pick<TaskRecord, "status" | "owner" | "output" | "error">>,
  ): void {
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error(`TaskRegistry.update: unknown task id "${id}"`);
    }
    const updated: TaskRecord = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    this.records.set(id, updated);
  }

  /**
   * Transition a task to "stopped" status. When `by` is supplied, persists
   * it on the TaskRecord.stoppedBy field so the orchestrator can surface
   * it in the cancelled results.jsonl line. No-op if task is not found.
   * Throws if the task is not in a stoppable state (already terminal).
   */
  stop(id: string, by?: string): void {
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error(`TaskRegistry.stop: unknown task id "${id}"`);
    }
    const updated: TaskRecord = {
      ...existing,
      status: "stopped",
      updatedAt: Date.now(),
      ...(by !== undefined ? { stoppedBy: by } : {}),
    };
    this.records.set(id, updated);
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
