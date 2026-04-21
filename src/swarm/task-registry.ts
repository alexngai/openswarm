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
import type { LaneEvent } from "./events.js";

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners: Array<(event: LaneEvent) => void> = [];

  /**
   * Create a new TaskRecord. Auto-assigns `id` via `crypto.randomUUID()`.
   * Populates `createdAt` and `updatedAt` as `Date.now()`.
   */
  create(packet: Omit<TaskPacket, "id">): TaskRecord {
    const id = randomUUID();
    const now = Date.now();
    const record: TaskRecord = {
      ...packet,
      id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    return record;
  }

  /** Retrieve a TaskRecord by id. Returns `undefined` if not found. */
  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
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
