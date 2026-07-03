/**
 * merge-swarm-events.test.ts — GitHub #15.
 *
 * Verifies that swarm view events (produced out-of-band on the orchestrator
 * lane bus) are interleaved into a single REPL turn's engine-event stream and
 * that the merged stream completes when the base turn completes.
 */

import { describe, it, expect } from "vitest";
import { mergeTurnWithSwarm, type SwarmEventSource } from "./merge-swarm-events.js";
import type { NormalizedEvent } from "../../core/types.js";

/** A controllable async turn stream: push engine events, then end(). */
function makeTurn(): {
  turn: AsyncIterable<NormalizedEvent>;
  push: (e: NormalizedEvent) => void;
  end: () => void;
} {
  const queue: NormalizedEvent[] = [];
  let resolveNext: ((r: IteratorResult<NormalizedEvent>) => void) | undefined;
  let done = false;
  const push = (e: NormalizedEvent): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r({ value: e, done: false });
    } else queue.push(e);
  };
  const end = (): void => {
    done = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r({ value: undefined as unknown as NormalizedEvent, done: true });
    }
  };
  const turn: AsyncIterable<NormalizedEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<NormalizedEvent>> {
          const q = queue.shift();
          if (q !== undefined) return Promise.resolve({ value: q, done: false });
          if (done) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((r) => (resolveNext = r));
        },
      };
    },
  };
  return { turn, push, end };
}

/** A swarm source whose sink can be fired on demand. */
function makeSource(): { source: SwarmEventSource; emit: (e: NormalizedEvent) => void; unsubscribed: () => boolean } {
  let sink: ((e: NormalizedEvent) => void) | undefined;
  let unsubbed = false;
  return {
    source: {
      subscribe(s) {
        sink = s;
        return () => {
          unsubbed = true;
          sink = undefined;
        };
      },
    },
    emit: (e) => sink?.(e),
    unsubscribed: () => unsubbed,
  };
}

const spawned: NormalizedEvent = { type: "agent_spawned", agentId: "w1", name: "x", role: "x" };
const delta = (t: string): NormalizedEvent => ({ type: "text_delta", text: t });

describe("mergeTurnWithSwarm", () => {
  it("passes through base events unchanged when no swarm events fire", async () => {
    const { turn, push, end } = makeTurn();
    const { source } = makeSource();
    const collected: NormalizedEvent[] = [];
    const p = (async () => {
      for await (const e of mergeTurnWithSwarm(turn, source)) collected.push(e);
    })();
    push(delta("a"));
    push(delta("b"));
    end();
    await p;
    expect(collected).toEqual([delta("a"), delta("b")]);
  });

  it("interleaves swarm events that fire mid-turn", async () => {
    const { turn, push, end } = makeTurn();
    const { source, emit } = makeSource();
    const collected: NormalizedEvent[] = [];
    const p = (async () => {
      for await (const e of mergeTurnWithSwarm(turn, source)) collected.push(e);
    })();
    const helloDelta = delta("hello");
    // Give the merged generator a tick to start racing.
    await new Promise((r) => setTimeout(r, 5));
    emit(spawned); // arrives while the base stream is idle
    await new Promise((r) => setTimeout(r, 5));
    push(helloDelta);
    end();
    await p;
    expect(collected).toContainEqual(spawned);
    expect(collected).toContainEqual(helloDelta);
    // Swarm event surfaced before the later base delta (stable references).
    expect(collected.indexOf(spawned)).toBeLessThan(collected.indexOf(helloDelta));
  });

  it("drains swarm events queued alongside the terminal base event, then completes + unsubscribes", async () => {
    const { turn, push, end } = makeTurn();
    const { source, emit, unsubscribed } = makeSource();
    const collected: NormalizedEvent[] = [];
    const p = (async () => {
      for await (const e of mergeTurnWithSwarm(turn, source)) collected.push(e);
    })();
    await new Promise((r) => setTimeout(r, 5));
    push(delta("only"));
    emit(spawned);
    end();
    await p;
    expect(collected).toContainEqual(delta("only"));
    expect(collected).toContainEqual(spawned);
    expect(unsubscribed()).toBe(true);
  });
});
