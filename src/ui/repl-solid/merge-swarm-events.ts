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
 * Lifetime: the subscription is scoped to a single turn. Because the `agent`
 * tool blocks the turn until its sub-agents finish (`wait: true` default), all
 * member events fire before the turn's terminal `message_stop`. When the base
 * turn stream ends we drain any already-queued swarm events, then stop and
 * unsubscribe — a still-running background member (rare `wait: false` case)
 * simply stops projecting into a finished turn rather than wedging the merged
 * iterator open.
 */

import type { NormalizedEvent } from "../../core/types.js";

export interface SwarmEventSource {
  /** Register a sink for translated view events; returns an unsubscribe fn. */
  subscribe(sink: (evt: NormalizedEvent) => void): () => void;
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
