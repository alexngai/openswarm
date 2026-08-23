import { describe, it, expect } from "vitest";
import { WorkerPool } from "./worker-pool.js";

describe("WorkerPool", () => {
  it("rejects maxConcurrency < 1 at construction", () => {
    expect(() => new WorkerPool(0)).toThrow(/maxConcurrency/);
    expect(() => new WorkerPool(-1)).toThrow(/maxConcurrency/);
  });

  it("single acquire/release works and updates activeCount", async () => {
    const pool = new WorkerPool(1);
    expect(pool.activeCount).toBe(0);
    const token = await pool.acquire();
    expect(pool.activeCount).toBe(1);
    token.release();
    expect(pool.activeCount).toBe(0);
  });

  it("respects concurrency cap — 4th acquire queues until release", async () => {
    const pool = new WorkerPool(3);
    const t1 = await pool.acquire();
    const t2 = await pool.acquire();
    const t3 = await pool.acquire();
    expect(pool.activeCount).toBe(3);

    let t4resolved = false;
    const t4 = pool.acquire().then((tok) => {
      t4resolved = true;
      return tok;
    });
    // Give the microtask queue a chance to flush.
    await Promise.resolve();
    expect(t4resolved).toBe(false);
    expect(pool.activeCount).toBe(3);

    t1.release();
    const t4token = await t4;
    expect(t4resolved).toBe(true);
    expect(pool.activeCount).toBe(3); // one out, one in

    t2.release();
    t3.release();
    t4token.release();
    expect(pool.activeCount).toBe(0);
  });

  it("queue is FIFO — older acquires resolve before newer ones", async () => {
    const pool = new WorkerPool(1);
    const held = await pool.acquire();
    const order: number[] = [];
    const a = pool.acquire().then((t) => {
      order.push(1);
      return t;
    });
    const b = pool.acquire().then((t) => {
      order.push(2);
      return t;
    });
    const c = pool.acquire().then((t) => {
      order.push(3);
      return t;
    });

    held.release();
    (await a).release();
    (await b).release();
    (await c).release();
    expect(order).toEqual([1, 2, 3]);
  });

  it("drain() resolves when all outstanding tokens are released", async () => {
    const pool = new WorkerPool(2);
    const t1 = await pool.acquire();
    const t2 = await pool.acquire();

    let drained = false;
    const drainPromise = pool.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    t1.release();
    await Promise.resolve();
    expect(drained).toBe(false);

    t2.release();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it("drain() resolves immediately when pool is already idle", async () => {
    const pool = new WorkerPool(1);
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  it("close() rejects pending queued acquires and blocks new ones", async () => {
    const pool = new WorkerPool(1);
    const held = await pool.acquire();

    const pending = pool.acquire();
    await Promise.resolve();

    pool.close();
    await expect(pending).rejects.toThrow(/pool closed/);
    await expect(pool.acquire()).rejects.toThrow(/pool is closed/);

    // Releasing an existing token still works (idempotent + no-op on closed pool).
    expect(() => held.release()).not.toThrow();
  });

  it("double release is a no-op (idempotent)", async () => {
    const pool = new WorkerPool(1);
    const token = await pool.acquire();
    token.release();
    expect(pool.activeCount).toBe(0);
    // Should not throw or decrement below zero.
    expect(() => token.release()).not.toThrow();
    expect(pool.activeCount).toBe(0);
  });
});
