/**
 * FX-CLAIM-002 — a task has one owner, and a terminal result is final
 * (docs/67 `WP-06`).
 *
 * Two agents that both believe they own a task will both do the work, both
 * write to the same worktree, and both report an outcome; the second report
 * silently replaced the first. The gate for `WP-06` is 10,000 claim attempts
 * producing one owner, which these tests drive through the async `TaskAPI`
 * surface rather than the synchronous registry method, because the async
 * surface is the one agents actually reach and the one that yields between
 * callers.
 */

import { describe, it, expect } from "vitest";

import { TaskRegistry } from "./task-registry.js";
import type { TaskPacket, TaskRecord } from "./host.js";
import type { AgentId } from "../core/types.js";

function packet(prompt = "work"): Omit<TaskPacket, "id"> {
  return {
    prompt,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
  };
}

/**
 * `pullNext` as an agent reaches it: through an async boundary. The awaits are
 * the point — they are where a second claimant gets to run, which is exactly
 * the interleaving a synchronous test cannot produce.
 */
async function pullAsync(
  registry: TaskRegistry,
  scope: string,
  claimer: AgentId,
): Promise<TaskRecord | null> {
  await Promise.resolve();
  const claimed = registry.pullNext(scope, claimer);
  await Promise.resolve();
  return claimed;
}

const ATTEMPTS = 10_000;

describe("FX-CLAIM-002 concurrent claims", () => {
  it("gives one task to exactly one of 10,000 claimants", async () => {
    const registry = new TaskRegistry();
    const only = registry.create(packet("the only task"));

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        pullAsync(registry, only.scope, `agent-${i}` as AgentId),
      ),
    );

    const winners = results.filter((r): r is TaskRecord => r !== null);
    expect(winners).toHaveLength(1);
    expect(registry.get(only.id)?.owner).toBe(winners[0]!.owner);
    expect(registry.get(only.id)?.status).toBe("running");
  });

  it("hands out 10,000 tasks to 10,000 claimants with no task claimed twice", async () => {
    const registry = new TaskRegistry();
    const created = Array.from({ length: ATTEMPTS }, (_, i) =>
      registry.create(packet(`work ${i}`)),
    );
    const scope = created[0]!.scope;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        pullAsync(registry, scope, `agent-${i}` as AgentId),
      ),
    );

    const claimed = results.filter((r): r is TaskRecord => r !== null);
    expect(claimed).toHaveLength(ATTEMPTS);

    // No task handed to two claimants, and no claimant handed two tasks.
    expect(new Set(claimed.map((r) => r.id)).size).toBe(ATTEMPTS);
    expect(new Set(claimed.map((r) => r.owner)).size).toBe(ATTEMPTS);

    // And every task in the store agrees with whoever was told it owned it.
    for (const r of claimed) {
      expect(registry.get(r.id)?.owner).toBe(r.owner);
    }
  });

  it("gives one owner even when all 10,000 read before any of them writes", async () => {
    // The three tests above hold on a synchronous Map whatever the claim looks
    // like, because nothing gets to run between the check and the write. This
    // one separates the read from the write with an await, which is the shape
    // of every store that is not an in-process Map — a database round trip, an
    // RPC to a shared registry, a file read. A read-modify-write loses here:
    // all 10,000 read a pending, unowned task, and all 10,000 then write their
    // own id over it. Only a compare-and-swap refuses the stale 9,999.
    const registry = new TaskRegistry();
    const only = registry.create(packet("contested"));

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, async (_, i) => {
        const asRead = registry.get(only.id)!;
        await Promise.resolve();
        return registry.claim(only.id, `agent-${i}` as AgentId, asRead);
      }),
    );

    const winners = results.filter((r): r is TaskRecord => r !== null);
    expect(winners).toHaveLength(1);
    expect(registry.get(only.id)?.owner).toBe(winners[0]!.owner);
  });

  it("survives more claimants than tasks without double-assigning", async () => {
    const registry = new TaskRegistry();
    const created = Array.from({ length: 100 }, (_, i) => registry.create(packet(`w${i}`)));
    const scope = created[0]!.scope;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        pullAsync(registry, scope, `agent-${i}` as AgentId),
      ),
    );

    const claimed = results.filter((r): r is TaskRecord => r !== null);
    expect(claimed).toHaveLength(100);
    expect(new Set(claimed.map((r) => r.id)).size).toBe(100);
  });
});

describe("the claim is a compare-and-swap, not a read then a write", () => {
  it("refuses a claim whose expectation is stale", async () => {
    // This is the property that keeps holding if the store ever grows an await
    // between the read and the write. Without it, the second claimant's write
    // would land on top of the first and both would believe they own the task.
    const registry = new TaskRegistry();
    const task = registry.create(packet());

    const asRead = registry.get(task.id)!;
    const first = registry.claim(task.id, "agent-first" as AgentId, asRead);
    expect(first).not.toBeNull();

    const second = registry.claim(task.id, "agent-second" as AgentId, asRead);
    expect(second).toBeNull();
    expect(registry.get(task.id)?.owner).toBe("agent-first");
  });

  it("refuses to claim a task that is no longer pending", () => {
    const registry = new TaskRegistry();
    const task = registry.create(packet());
    registry.update(task.id, { status: "running" });

    const current = registry.get(task.id)!;
    expect(registry.claim(task.id, "agent-x" as AgentId, current)).toBeNull();
  });

  it("refuses to claim a task that has gone away", () => {
    const registry = new TaskRegistry();
    const task = registry.create(packet());
    expect(registry.claim("no-such-task", "agent-x" as AgentId, task)).toBeNull();
  });
});

describe("a terminal result is final", () => {
  it("keeps the first outcome when a second one is reported", () => {
    const registry = new TaskRegistry();
    const task = registry.create(packet());
    registry.update(task.id, { status: "running" });

    expect(registry.resolve(task.id, { status: "succeeded", output: "the real result" })).toBe(
      true,
    );
    expect(registry.resolve(task.id, { status: "failed", error: "a later report" })).toBe(false);

    const after = registry.get(task.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.output).toBe("the real result");
  });

  it("refuses to move a finished task back to running", () => {
    const registry = new TaskRegistry();
    const task = registry.create(packet());
    registry.resolve(task.id, { status: "succeeded", output: "done" });

    expect(() => registry.update(task.id, { status: "running" })).toThrow(/already succeeded/);
    expect(registry.get(task.id)?.status).toBe("succeeded");
  });

  it("does not let a late stop discard a result that already landed", () => {
    // stop() promised this in its doc comment and did the opposite: it rewrote
    // the status unconditionally, so a cancellation racing a completion turned
    // a finished task into a cancelled one.
    const registry = new TaskRegistry();
    const task = registry.create(packet());
    registry.resolve(task.id, { status: "succeeded", output: "finished first" });

    registry.stop(task.id, "orchestrator");

    const after = registry.get(task.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.output).toBe("finished first");
    expect(after.stoppedBy).toBeUndefined();
  });

  it("still accepts trailing output after a terminal transition", () => {
    // A late chunk of streamed output is ordinary and says nothing about the
    // outcome, so the guard is about status, not about the record being frozen.
    const registry = new TaskRegistry();
    const task = registry.create(packet());
    registry.resolve(task.id, { status: "succeeded", output: "head" });

    registry.appendOutput(task.id, " tail");
    expect(registry.get(task.id)?.output).toBe("head tail");
    expect(registry.get(task.id)?.status).toBe("succeeded");
  });

  it("lands the status and its payload in one write", () => {
    // Sampled between two separate writes, a task is briefly succeeded with
    // nothing to show — indistinguishable from one that produced nothing.
    const registry = new TaskRegistry();
    const task = registry.create(packet());

    const seen: Array<{ status: string; output?: string }> = [];
    const observe = (): void => {
      const r = registry.get(task.id)!;
      seen.push({ status: r.status, ...(r.output !== undefined && { output: r.output }) });
    };

    observe();
    registry.resolve(task.id, { status: "succeeded", output: "result" });
    observe();

    expect(seen).toEqual([
      { status: "pending" },
      { status: "succeeded", output: "result" },
    ]);
  });
});
