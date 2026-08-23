/**
 * WP-04 / FX-PROC: cancellation must reap the tree, not the root.
 *
 * These assert against real processes rather than a mock, because the property
 * under test is an operating-system one — whether a grandchild outlives the
 * kill — and a mock of `process.kill` would assert only that we called it.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { killProcessTree } from "./tree.js";

/** True while a pid exists. Signal 0 checks liveness without delivering. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for a predicate, polling, up to a budget. Returns its final value. */
async function until(pred: () => boolean, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

describe.skipIf(process.platform === "win32")("killProcessTree", () => {
  it("kills a grandchild that a plain child.kill() would orphan", async () => {
    // A shell that spawns a long sleep and reports its pid, then waits. Killing
    // only the shell leaves the sleep parented to init and running.
    const child = spawn(
      "/bin/bash",
      ["-c", 'sleep 300 & echo "$!"; wait'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const line = buf.split("\n")[0];
        if (line && /^\d+$/.test(line.trim())) resolve(Number(line.trim()));
      });
      child.on("error", reject);
      setTimeout(() => reject(new Error("grandchild never reported its pid")), 5_000);
    });

    expect(alive(grandchildPid)).toBe(true);

    killProcessTree(child);

    expect(await until(() => !alive(grandchildPid))).toBe(true);
    expect(await until(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });

  it("leaves this process alive when the child does not lead a group", async () => {
    // The safety property the -pid form depends on: a non-detached child shares
    // our group, whose id is not the child's pid, so the group signal finds
    // nothing and falls back to the single pid. If that reasoning were wrong
    // this test would take the test runner down with it.
    const child = spawn("/bin/bash", ["-c", "sleep 300"], {
      detached: false,
      stdio: "ignore",
    });

    killProcessTree(child);

    expect(await until(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  });

  it("is a no-op on a child that already exited", async () => {
    const child = spawn("/bin/bash", ["-c", "exit 0"], {
      detached: true,
      stdio: "ignore",
    });
    await until(() => child.exitCode !== null);

    expect(() => killProcessTree(child)).not.toThrow();
  });

  it("is a no-op when the spawn never produced a pid", () => {
    expect(() => killProcessTree({ pid: undefined } as never)).not.toThrow();
  });
});
