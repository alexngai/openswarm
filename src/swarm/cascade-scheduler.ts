/**
 * cascade-scheduler.ts — debounced, coalescing cascade-rebase trigger (docs/44 P3).
 *
 * When a stream merge advances a parent/target stream, its dependent (forked)
 * streams should rebase onto it. Firing a rebase per merge would storm under a
 * burst of merges into the same root, so requests are **coalesced per root and
 * debounced**: repeated `request(root)` within the window collapse to one run.
 *
 * Two drains:
 *   - timer auto-fire after `debounceMs` of quiet (trickle / daemon case);
 *   - `flush()` runs all pending immediately (batch topology case — peer-team
 *     requests during its merge loop, then flushes once at the end).
 *
 * The `run` callback is injected (StandaloneHost.cascadeRebase in production),
 * so the scheduler is unit-testable without git.
 */

import type { CascadeRebaseResult } from "./adapters/git-cascade-branch-policy.js";

export interface CascadeSchedulerOptions {
  /** Quiet window before an un-flushed request fires. Default 2000ms. */
  readonly debounceMs?: number;
  /** Run a cascade for a root; returns null when the adapter can't cascade. */
  readonly run: (rootStream: string) => Promise<CascadeRebaseResult | null>;
}

export class CascadeScheduler {
  private readonly debounceMs: number;
  private readonly run: CascadeSchedulerOptions["run"];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly results = new Map<string, CascadeRebaseResult | null>();

  constructor(opts: CascadeSchedulerOptions) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.run = opts.run;
  }

  /**
   * Request a cascade for `rootStream`. Repeated requests within the debounce
   * window coalesce — the timer is re-armed each time, so exactly one run fires
   * per quiet window (or per `flush`).
   */
  request(rootStream: string): void {
    const existing = this.timers.get(rootStream);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.fire(rootStream);
    }, this.debounceMs);
    // A pending debounce must not keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(rootStream, timer);
  }

  private async fire(rootStream: string): Promise<void> {
    this.timers.delete(rootStream);
    try {
      this.results.set(rootStream, await this.run(rootStream));
    } catch (err) {
      this.results.set(rootStream, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run all still-pending cascades now (cancelling their timers) and return the
   * accumulated results by root (including any that already auto-fired).
   */
  async flush(): Promise<ReadonlyMap<string, CascadeRebaseResult | null>> {
    const roots = [...this.timers.keys()];
    for (const root of roots) {
      const t = this.timers.get(root);
      if (t !== undefined) clearTimeout(t);
      this.timers.delete(root);
    }
    await Promise.all(roots.map((r) => this.fire(r)));
    return this.results;
  }

  /** Cancel pending timers without running (dispose path). */
  cancel(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
