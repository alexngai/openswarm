/**
 * branch-lock.test.ts — covers both layers:
 *   (A) Pure `detectCollisions` semantics (originally derived from a reference implementation).
 *   (B) Atomic filesystem lock (acquire/release/stale-reclaim/timeout).
 *
 * Uses `os.tmpdir() + mkdtemp` for isolated lock dirs per test.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquire,
  detectCollisions,
  sanitizeBranchName,
  fnv1a4,
  type BranchLockIntent,
} from "./branch-lock.js";

// ---------------------------------------------------------------------------
// Tmp-dir bookkeeping
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkTmpLockDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-lock-"));
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// (B) Atomic lock
// ---------------------------------------------------------------------------

describe("acquire (atomic filesystem lock)", () => {
  it("serializes sequential acquires — second only enters after first releases", async () => {
    const lockDir = await mkTmpLockDir();
    const branch = "feature/x";
    const order: string[] = [];

    const l1 = await acquire(branch, {
      agentId: "a1",
      timeoutMs: 2_000,
      lockDir,
      pollIntervalMs: 20,
    });
    order.push("l1-acquired");

    // Start second acquire in the background — it must block until release.
    const l2Promise = acquire(branch, {
      agentId: "a2",
      timeoutMs: 2_000,
      lockDir,
      pollIntervalMs: 20,
    }).then((h) => {
      order.push("l2-acquired");
      return h;
    });

    // Give the poller time to observe EEXIST at least once.
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual(["l1-acquired"]);

    order.push("l1-releasing");
    await l1.release();

    const l2 = await l2Promise;
    expect(order).toEqual(["l1-acquired", "l1-releasing", "l2-acquired"]);
    await l2.release();
  });

  it("three sequential acquires complete FIFO-ish (each waits for the previous)", async () => {
    const lockDir = await mkTmpLockDir();
    const branch = "topic/a";
    const h1 = await acquire(branch, {
      agentId: "a1",
      timeoutMs: 2_000,
      lockDir,
      pollIntervalMs: 15,
    });
    await h1.release();
    const h2 = await acquire(branch, {
      agentId: "a2",
      timeoutMs: 2_000,
      lockDir,
      pollIntervalMs: 15,
    });
    await h2.release();
    const h3 = await acquire(branch, {
      agentId: "a3",
      timeoutMs: 2_000,
      lockDir,
      pollIntervalMs: 15,
    });
    await h3.release();
    // All releases should have removed the lock file.
    const files = await fs.readdir(lockDir);
    expect(files).toHaveLength(0);
  });

  it("times out when lock is held past timeoutMs", async () => {
    const lockDir = await mkTmpLockDir();
    const branch = "feature/contended";
    const h1 = await acquire(branch, {
      agentId: "a1",
      timeoutMs: 2_000,
      lockDir,
    });
    try {
      await expect(
        acquire(branch, {
          agentId: "a2",
          timeoutMs: 150,
          lockDir,
          pollIntervalMs: 20,
        }),
      ).rejects.toThrow(/timed out acquiring lock/);
    } finally {
      await h1.release();
    }
  });

  it("reclaims a stale lock (dead pid + old timestamp)", async () => {
    const lockDir = await mkTmpLockDir();
    await fs.mkdir(lockDir, { recursive: true });
    const branch = "feature/stale";
    const filename = sanitizeBranchName(branch);
    const lockPath = path.join(lockDir, filename);
    // Simulate a crashed holder: bogus PID + old acquiredAt.
    const stale = {
      ownerAgentId: "ghost",
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      pid: 999_999, // highly unlikely to exist on this host
      branch,
    };
    await fs.writeFile(lockPath, JSON.stringify(stale) + "\n", "utf8");

    // Fresh acquire should reclaim rather than block.
    const h = await acquire(branch, {
      agentId: "a-new",
      timeoutMs: 500,
      lockDir,
      pollIntervalMs: 20,
      staleReclaimAfterMs: 1_000, // lower threshold so the 120s-old lock qualifies
    });
    // After reclaim, file should now contain the new owner.
    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.ownerAgentId).toBe("a-new");
    expect(written.pid).toBe(process.pid);
    await h.release();
  });

  it("does NOT reclaim a lock whose pid is live (this process)", async () => {
    const lockDir = await mkTmpLockDir();
    await fs.mkdir(lockDir, { recursive: true });
    const branch = "feature/alive";
    const filename = sanitizeBranchName(branch);
    const lockPath = path.join(lockDir, filename);
    const live = {
      ownerAgentId: "self",
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      pid: process.pid, // alive by definition
      branch,
    };
    await fs.writeFile(lockPath, JSON.stringify(live) + "\n", "utf8");

    // Acquire should time out — pid is alive so stale reclaim is skipped.
    await expect(
      acquire(branch, {
        agentId: "other",
        timeoutMs: 200,
        lockDir,
        pollIntervalMs: 20,
        staleReclaimAfterMs: 1_000,
      }),
    ).rejects.toThrow(/timed out acquiring lock/);
  });

  it("release is idempotent (double-release does not throw)", async () => {
    const lockDir = await mkTmpLockDir();
    const h = await acquire("feature/idem", {
      agentId: "a1",
      timeoutMs: 1_000,
      lockDir,
    });
    await h.release();
    await expect(h.release()).resolves.toBeUndefined();
  });

  it("concurrent acquires on the same branch — only one holds at a time", async () => {
    const lockDir = await mkTmpLockDir();
    const branch = "concurrent/x";
    const [result1, result2] = await Promise.all([
      (async () => {
        const h = await acquire(branch, {
          agentId: "a",
          timeoutMs: 3_000,
          lockDir,
          pollIntervalMs: 20,
        });
        const t = Date.now();
        await new Promise((r) => setTimeout(r, 80));
        await h.release();
        return { id: "a", enteredAt: t };
      })(),
      (async () => {
        // Small head-start delay so "a" wins the first open.
        await new Promise((r) => setTimeout(r, 10));
        const h = await acquire(branch, {
          agentId: "b",
          timeoutMs: 3_000,
          lockDir,
          pollIntervalMs: 20,
        });
        const t = Date.now();
        await h.release();
        return { id: "b", enteredAt: t };
      })(),
    ]);
    // "b" must have entered after "a" — difference ≥ ~60ms due to hold time.
    expect(result2.enteredAt - result1.enteredAt).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Filename sanitization + hash
// ---------------------------------------------------------------------------

describe("sanitizeBranchName", () => {
  it("replaces unsafe chars with - and appends a 4-char hash", () => {
    const name = sanitizeBranchName("feature/X with spaces");
    // Only [A-Za-z0-9._-] + the trailing `.lock` extension.
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.lock$/);
    expect(name.endsWith(".lock")).toBe(true);
    // Contains a 4-char hex hash suffix before `.lock`.
    expect(name).toMatch(/-[0-9a-f]{4}\.lock$/);
  });

  it("same branch input produces a stable hash", () => {
    expect(fnv1a4("feature/x")).toBe(fnv1a4("feature/x"));
    expect(fnv1a4("feature/x")).toHaveLength(4);
    expect(fnv1a4("feature/x")).toMatch(/^[0-9a-f]{4}$/);
  });

  it("different branches produce different sanitized filenames", () => {
    // `a/b` and `a-b` sanitize identically before the hash — hash must disambiguate.
    const n1 = sanitizeBranchName("a/b");
    const n2 = sanitizeBranchName("a-b");
    expect(n1).not.toBe(n2);
  });
});

// ---------------------------------------------------------------------------
// (A) Pure collision detector
// ---------------------------------------------------------------------------

describe("detectCollisions", () => {
  it("reports two intents on same branch + module as a collision", () => {
    const intents: BranchLockIntent[] = [
      { laneId: "lane-a", branch: "feature/lock", modules: ["runtime/mcp"] },
      { laneId: "lane-b", branch: "feature/lock", modules: ["runtime/mcp"] },
    ];
    const collisions = detectCollisions(intents);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      branch: "feature/lock",
      module: "runtime/mcp",
    });
    expect(collisions[0]!.laneIds).toEqual(["lane-a", "lane-b"]);
  });

  it("detects nested module scope (parent/child overlap reports parent)", () => {
    const intents: BranchLockIntent[] = [
      { laneId: "lane-a", branch: "feature/lock", modules: ["runtime"] },
      { laneId: "lane-b", branch: "feature/lock", modules: ["runtime/mcp"] },
    ];
    const collisions = detectCollisions(intents);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.module).toBe("runtime");
  });

  it("ignores intents on different branches even with identical modules", () => {
    const intents: BranchLockIntent[] = [
      { laneId: "lane-a", branch: "feature/a", modules: ["runtime/mcp"] },
      { laneId: "lane-b", branch: "feature/b", modules: ["runtime/mcp"] },
    ];
    expect(detectCollisions(intents)).toEqual([]);
  });

  it("returns [] for disjoint modules on the same branch", () => {
    const intents: BranchLockIntent[] = [
      { laneId: "lane-a", branch: "feature/x", modules: ["pkg/foo"] },
      { laneId: "lane-b", branch: "feature/x", modules: ["pkg/bar"] },
    ];
    expect(detectCollisions(intents)).toEqual([]);
  });
});
