/**
 * FX-RW-009..012 — the single-writer lease under real contention (docs/63 `WP-11`).
 *
 * The in-process fixtures cover the state machine: renewal, bounded holds,
 * cancellation, and release that cannot steal. Mutual exclusion and fairness are
 * tested across real processes instead, because a lease whose only evidence is
 * one event loop has not been tested against the thing it exists for — several
 * agents in one directory, each with its own memory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  acquireWriteLease,
  bumpGeneration,
  readGeneration,
  withWriteLease,
  LeaseLostError,
  LeaseTimeoutError,
} from "./write-lease.js";

const run = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "lease-")));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/**
 * The cross-process fixtures run the lease in real processes, so they need the
 * compiled module rather than the source vitest is executing — the same
 * arrangement `durable-append.test.ts` uses, built by the suite's globalSetup.
 */
const compiled = (): string => path.resolve("dist/kernel/write-lease.js");

describe("write lease: the state machine", () => {
  it("serves one holder and makes the next wait", async () => {
    const first = await acquireWriteLease(dir, { agentId: "a" });
    await expect(
      acquireWriteLease(dir, { agentId: "b", timeoutMs: 200 }),
    ).rejects.toThrow(LeaseTimeoutError);
    await first.release();

    // ...and the queue is usable again once released, rather than poisoned by
    // the writer that gave up.
    const second = await acquireWriteLease(dir, { agentId: "b", timeoutMs: 2_000 });
    expect(second.held).toBe(true);
    await second.release();
  });

  it("renews a hold, and refuses to renew past the ceiling", async () => {
    const lease = await acquireWriteLease(dir, {
      agentId: "a",
      ttlMs: 10_000,
      maxHoldMs: 120,
    });
    await lease.renew();
    expect(lease.held).toBe(true);

    await new Promise((r) => setTimeout(r, 160));
    await expect(lease.renew()).rejects.toThrow(LeaseLostError);
    expect(lease.held).toBe(false);
  });

  it("hands an expired lease to a waiter, and the dead holder cannot take it back", async () => {
    // A holder that stops renewing stands in for one that died: from every other
    // process the two are the same observation.
    const abandoned = await acquireWriteLease(dir, { agentId: "dead", ttlMs: 50 });
    await new Promise((r) => setTimeout(r, 90));

    const next = await acquireWriteLease(dir, { agentId: "live", timeoutMs: 5_000 });
    expect(next.held).toBe(true);

    // The abandoned holder still believes it holds the lease. Neither renewing
    // nor releasing may touch the lease that replaced it.
    await expect(abandoned.renew()).rejects.toThrow(LeaseLostError);
    await abandoned.release();
    expect(next.held).toBe(true);
    await expect(
      acquireWriteLease(dir, { agentId: "third", timeoutMs: 200 }),
    ).rejects.toThrow(LeaseTimeoutError);

    await next.release();
  });

  it("releases the ticket when a waiter is cancelled", async () => {
    const held = await acquireWriteLease(dir, { agentId: "holder" });
    const controller = new AbortController();
    const cancelled = acquireWriteLease(dir, {
      agentId: "gives-up",
      signal: controller.signal,
    });
    // Let it take a ticket and start waiting before cancelling.
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);

    await held.release();

    // The cancelled writer's ticket must not outrank a writer that arrives now,
    // or the queue would stall behind a process that has gone.
    const after = await acquireWriteLease(dir, { agentId: "next", timeoutMs: 3_000 });
    expect(after.held).toBe(true);
    await after.release();
    expect(await fsp.readdir(path.join(dir, ".openswarm", "write-lease", "queue"))).toEqual(
      [],
    );
  });

  it("keeps a slow body's lease alive, instead of letting it be stolen mid-write", async () => {
    // Without the heartbeat this is the bug that matters most: the body is still
    // writing when its lease expires, and a second writer is admitted.
    const ttlMs = 150;
    const body = withWriteLease(dir, { agentId: "slow", ttlMs }, async () => {
      await new Promise((r) => setTimeout(r, ttlMs * 4));
      return "finished";
    });

    // Long enough that an unrenewed lease would have lapsed several times over.
    await new Promise((r) => setTimeout(r, ttlMs * 2));
    await expect(
      acquireWriteLease(dir, { agentId: "opportunist", timeoutMs: 200 }),
    ).rejects.toThrow(LeaseTimeoutError);

    await expect(body).resolves.toBe("finished");
  });

  it("reports a body that outran its bounded hold rather than passing it off as clean", async () => {
    // The lease cannot be renewed past the ceiling, and a partial write cannot be
    // safely abandoned, so the body runs on. What must not happen is the caller
    // being told the work was exclusive when it was not.
    await expect(
      withWriteLease(dir, { agentId: "overruns", ttlMs: 100, maxHoldMs: 150 }, async () => {
        await new Promise((r) => setTimeout(r, 700));
        return "done anyway";
      }),
    ).rejects.toThrow(LeaseLostError);
  });

  it("releases on a throwing body, and twice is not an error", async () => {
    await expect(
      withWriteLease(dir, { agentId: "a" }, async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");

    const lease = await acquireWriteLease(dir, { agentId: "b", timeoutMs: 1_000 });
    await lease.release();
    await lease.release();
  });

  it("advances a generation every process can read, and only under the lease", async () => {
    expect(await readGeneration(dir)).toBe(1);

    const lease = await acquireWriteLease(dir, { agentId: "a" });
    expect(await bumpGeneration(dir, lease)).toBe(2);
    expect(await bumpGeneration(dir, lease)).toBe(3);
    await lease.release();

    expect(await readGeneration(dir)).toBe(3);
    await expect(bumpGeneration(dir, lease)).rejects.toThrow(LeaseLostError);
  });
});

/**
 * Writer body used by the cross-process fixtures: take the lease, record the
 * window it was held for, release. Interleaved windows in the log are the
 * failure this is looking for.
 */
function writerScript(mod: string, root: string, log: string): string {
  return `
    import { withWriteLease } from ${JSON.stringify(mod)};
    import * as fs from "node:fs";
    const id = process.argv[2];
    await withWriteLease(${JSON.stringify(root)}, { agentId: id, timeoutMs: 60000 },
      async (lease) => {
        fs.appendFileSync(${JSON.stringify(log)}, "start " + id + " " + lease.ticket + "\\n");
        await new Promise((r) => setTimeout(r, 15));
        fs.appendFileSync(${JSON.stringify(log)}, "end " + id + " " + lease.ticket + "\\n");
      });
  `;
}

describe("write lease: real processes", () => {
  it("has a compiled module to run in a real process", async () => {
    await expect(fsp.access(compiled())).resolves.toBeUndefined();
  });

  it("FX-RW-009 admits exactly one writer at a time across 16 processes", async () => {
    const log = path.join(dir, "windows.log");
    const script = path.join(dir, "writer.mjs");
    await fsp.writeFile(script, writerScript(compiled(), dir, log), "utf8");

    const writers = Array.from({ length: 16 }, (_, i) =>
      run(process.execPath, [script, `w${i}`]),
    );
    const results = await Promise.allSettled(writers);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);

    // Perfect nesting is the whole assertion: every start is followed by its own
    // end, so no two holds ever overlapped.
    const entries = (await fsp.readFile(log, "utf8")).trim().split("\n");
    expect(entries).toHaveLength(32);
    for (let i = 0; i < entries.length; i += 2) {
      const [startKind, startId] = entries[i]!.split(" ");
      const [endKind, endId] = entries[i + 1]!.split(" ");
      expect([startKind, endKind]).toEqual(["start", "end"]);
      expect(endId).toBe(startId);
    }
  }, 90_000);

  it("FX-RW-010 serves queued writers in the order they arrived", async () => {
    // Fairness is only observable once the queue has built up, so the lease is
    // held while the writers line up behind it.
    const log = path.join(dir, "order.log");
    const script = path.join(dir, "writer.mjs");
    await fsp.writeFile(script, writerScript(compiled(), dir, log), "utf8");

    const blocker = await acquireWriteLease(dir, { agentId: "blocker", ttlMs: 30_000 });

    const queued: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      queued.push(run(process.execPath, [script, `w${i}`]));
      // Space the arrivals so "the order they arrived" is a fact about the run
      // rather than about scheduling.
      await new Promise((r) => setTimeout(r, 250));
    }

    await blocker.release();
    await Promise.all(queued);

    const served = (await fsp.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("start"))
      .map((l) => l.split(" ")[1]);
    expect(served).toEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);
  }, 90_000);

  it("FX-RW-011 takes over from a writer that was killed mid-hold", async () => {
    const script = path.join(dir, "holder.mjs");
    await fsp.writeFile(
      script,
      `
      import { acquireWriteLease } from ${JSON.stringify(compiled())};
      const lease = await acquireWriteLease(${JSON.stringify(dir)}, {
        agentId: "doomed", ttlMs: 400,
      });
      console.log("held");
      // No renewal loop, and no release: die holding it.
      await new Promise(() => {});
      `,
      "utf8",
    );

    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => {
        if (b.toString().includes("held")) resolve();
      });
      child.on("error", reject);
      setTimeout(() => reject(new Error("child never took the lease")), 20_000);
    });
    child.kill("SIGKILL");

    const started = Date.now();
    const recovered = await acquireWriteLease(dir, { agentId: "survivor", timeoutMs: 10_000 });
    expect(recovered.held).toBe(true);
    // Recovery is bounded by the TTL, not by the dead process being noticed.
    expect(Date.now() - started).toBeLessThan(5_000);
    await recovered.release();
  }, 60_000);

  it("FX-RW-011b reclaims a ticket from a writer that died before it ever held the lease", async () => {
    // The failure mode with nothing to expire: a ticket at the head of the queue
    // and no holder record, so the ordinary TTL never fires. Simulated by writing
    // a ticket nobody owns, which is exactly what the dead process leaves behind.
    const queueDir = path.join(dir, ".openswarm", "write-lease", "queue");
    await fsp.mkdir(queueDir, { recursive: true });
    await fsp.writeFile(path.join(queueDir, "000000000001"), "", "utf8");
    await fsp.writeFile(path.join(dir, ".openswarm", "write-lease", "next"), "2", "utf8");

    const started = Date.now();
    const lease = await acquireWriteLease(dir, {
      agentId: "arrives-later",
      ttlMs: 300,
      timeoutMs: 15_000,
    });
    expect(lease.held).toBe(true);
    // Bounded by the ticket being declared dead, not by the writer's own timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    await lease.release();
  }, 30_000);

  it("FX-RW-012 starts the next queued writer within five seconds under 32 active readers", async () => {
    // The gate. Readers deliberately do not take the lease, so this measures that
    // a read-heavy workspace cannot starve a writer — if readers ever begin
    // queueing, this is the fixture that will notice.
    const readerScript = path.join(dir, "reader.mjs");
    await fsp.writeFile(
      readerScript,
      `
      import * as fs from "node:fs";
      const root = ${JSON.stringify(dir)};
      const target = root + "/payload.txt";
      // Continuous read pressure: file reads plus directory scans of the lease
      // area, which is where a reader would contend if it contended at all.
      for (;;) {
        try { fs.readFileSync(target, "utf8"); } catch {}
        try { fs.readdirSync(root + "/.openswarm/write-lease/queue"); } catch {}
      }
      `,
      "utf8",
    );
    await fsp.writeFile(path.join(dir, "payload.txt"), "x".repeat(64 * 1024), "utf8");

    const readers: ChildProcess[] = [];
    for (let i = 0; i < 32; i++) {
      readers.push(spawn(process.execPath, [readerScript], { stdio: "ignore" }));
    }

    try {
      // Let the readers get going, so the measurement happens under load.
      await new Promise((r) => setTimeout(r, 750));

      const holder = await acquireWriteLease(dir, { agentId: "holder", ttlMs: 30_000 });

      let waitStarted = 0;
      const waiter = (async () => {
        waitStarted = Date.now();
        const lease = await acquireWriteLease(dir, {
          agentId: "queued",
          timeoutMs: 30_000,
        });
        const waitedMs = Date.now() - waitStarted;
        await lease.release();
        return waitedMs;
      })();

      // Make sure the waiter is queued before the release, or the measurement is
      // of an uncontended acquire.
      await new Promise((r) => setTimeout(r, 500));
      const releasedAt = Date.now();
      await holder.release();

      await waiter;
      const startedAfterReleaseMs = Date.now() - releasedAt;
      expect(startedAfterReleaseMs).toBeLessThan(5_000);
    } finally {
      for (const r of readers) r.kill("SIGKILL");
    }
  }, 120_000);
});
