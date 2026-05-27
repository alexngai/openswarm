/**
 * Execution scheduler for one batch of tool calls.
 *
 * Tasks declare the resources they touch via `accesses`. The scheduler runs
 * tasks whose accesses don't conflict with active or earlier-queued tasks
 * concurrently, and serializes tasks whose accesses do conflict in input
 * order. Result emission order is the responsibility of the caller — this
 * module only owns execution ordering.
 *
 * Ported from kimi-code's tool-scheduler module.
 */

import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "./access.js";

export interface ToolCallTask<Result> {
  readonly accesses: ToolAccessesType;
  /**
   * Begin execution. Returning a `result` promise (rather than awaiting
   * inline) lets the caller distinguish "starting" from "completed", which
   * matters for tasks that synchronously kick off async work.
   */
  readonly start: () => Promise<{ readonly result: Promise<Result> }>;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly resolve: (value: Result) => void;
  readonly reject: (err: unknown) => void;
}

function createControlled<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class ToolScheduler<Result> {
  private readonly activeTasks: Array<ScheduledToolCallTask<Result>> = [];
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];

  add(task: ToolCallTask<Result>): Promise<Result> {
    const { promise, resolve, reject } = createControlled<Result>();
    // Detach the unhandled-rejection tripwire — the caller will surface
    // failure through whichever consumer awaits the returned promise.
    promise.catch(() => undefined);

    const scheduled: ScheduledToolCallTask<Result> = { ...task, resolve, reject };
    if (this.isBlocked(scheduled, this.queuedTasks)) {
      this.queuedTasks.push(scheduled);
    } else {
      this.start(scheduled);
    }
    return promise;
  }

  private isBlocked(
    task: ToolCallTask<Result>,
    queuedBefore: readonly ToolCallTask<Result>[],
  ): boolean {
    return (
      this.conflictsWithAny(task, this.activeTasks) ||
      this.conflictsWithAny(task, queuedBefore)
    );
  }

  private conflictsWithAny(
    task: ToolCallTask<Result>,
    candidates: readonly ToolCallTask<Result>[],
  ): boolean {
    return candidates.some((c) => ToolAccesses.conflict(task.accesses, c.accesses));
  }

  private start(task: ScheduledToolCallTask<Result>): void {
    this.activeTasks.push(task);
    let started: Promise<{ readonly result: Promise<Result> }>;
    try {
      started = task.start();
    } catch (err) {
      task.reject(err);
      this.finish(task);
      return;
    }

    void started
      .then(({ result }) => result)
      .then(task.resolve, task.reject)
      .finally(() => this.finish(task));
  }

  private finish(task: ScheduledToolCallTask<Result>): void {
    const index = this.activeTasks.indexOf(task);
    if (index >= 0) this.activeTasks.splice(index, 1);
    this.startQueuedTasks();
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (this.isBlocked(task, stillQueued)) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}
