/**
 * merge-swarm-events.ts — interleave a swarm event source into a single REPL
 * turn's engine-event stream.
 *
 * GitHub #15: when the interactive REPL runs a turn in which the model spawns
 * sub-agents (the `agent` Tier 2 tool), the swarm member lifecycle is produced
 * out-of-band on the orchestrator's lane bus and translated into
 * `agent_spawned` / `agent_status` / `task_update` NormalizedEvents by
 * `subscribeSwarmViewEvents` (src/swarm/swarm-view-events.ts). Those events
 * must reach the REPL's `App` event pump, which consumes ONE async iterable per
 * turn. This helper merges the swarm source into that per-turn stream.
 *
 * Lifetime (GitHub #23): the merge is applied ONCE around the whole multi-turn
 * REPL stream, so the subscription — and the stateful SwarmViewTranslator behind
 * it — persists for the entire session. Long-lived members therefore persist
 * across turns in the view, and swarm events keep flowing while the REPL sits
 * idle between turns (the race below wakes on a swarm event even when the base
 * stream is blocked awaiting the next prompt). This is what lets the REPL attach
 * to a detached daemon team whose lifecycle is independent of REPL turns. The
 * subscription is torn down only when the base stream ends (session exit).
 *
 * `turn` is the base stream (a single turn's events, or — post-#23 — the entire
 * multi-turn stream); the parameter name is retained for continuity.
 */

import type { NormalizedEvent } from "../../core/types.js";

export interface SwarmEventSource {
  /** Register a sink for translated view events; returns an unsubscribe fn. */
  subscribe(sink: (evt: NormalizedEvent) => void): () => void;
}

/**
 * Fan one sink out to several swarm sources (GitHub #23). Used by the REPL
 * attach path to project BOTH the local live host (in-session `agent` spawns)
 * and a detached daemon team's `events.jsonl` tail into the same AgentTree /
 * TaskBoard. Unsubscribing tears down every underlying subscription.
 */
export function combineSwarmSources(
  ...sources: readonly SwarmEventSource[]
): SwarmEventSource {
  return {
    subscribe(sink: (evt: NormalizedEvent) => void): () => void {
      const unsubs = sources.map((s) => s.subscribe(sink));
      return () => {
        for (const u of unsubs) u();
      };
    },
  };
}

/**
 * Merge `source`'s events into `turn`, yielding both in arrival order and
 * completing when `turn` completes.
 */
export async function* mergeTurnWithSwarm(
  turn: AsyncIterable<NormalizedEvent>,
  source: SwarmEventSource,
): AsyncGenerator<NormalizedEvent> {
  const queue: NormalizedEvent[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = source.subscribe((evt) => {
    queue.push(evt);
    // Wake a pending race so a swarm event doesn't sit behind a slow base
    // .next() (e.g. the engine idling while a sub-agent runs).
    const w = wake;
    wake = undefined;
    w?.();
  });

  const iterator = turn[Symbol.asyncIterator]();
  try {
    let pendingNext = iterator.next();
    while (true) {
      // Arm the waker BEFORE flushing/yielding so an event that arrives during
      // the async yield (or between flush and race) still resolves the race
      // rather than stranding a queued event until the next base event
      // (TOCTOU hang).
      const swarmSignal = new Promise<"swarm">((resolve) => {
        wake = () => resolve("swarm");
      });
      // Flush everything the swarm produced since the last yield.
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      const raced = await Promise.race([
        pendingNext.then((r) => ({ kind: "base" as const, r })),
        swarmSignal.then((k) => ({ kind: k })),
      ]);
      if (raced.kind === "swarm") {
        // Loop back to flush the queue; pendingNext is still in flight.
        continue;
      }
      if (raced.r.done === true) break;
      yield raced.r.value;
      pendingNext = iterator.next();
    }
    // Drain trailing swarm events that arrived alongside the terminal base event.
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  } finally {
    wake = undefined;
    unsubscribe();
  }
}
