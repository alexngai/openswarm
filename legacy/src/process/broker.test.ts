/**
 * WP-04 / FX-PROC: the broker's guarantees, exercised against real children.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ProcessBroker,
  IsolationUnavailableError,
  getProcessBroker,
  setProcessBroker,
} from "./broker.js";
import { resetSandboxDetection } from "../tools/tier0/sandbox.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

describe.skipIf(process.platform === "win32")("ProcessBroker", () => {
  let broker: ProcessBroker;

  beforeEach(() => {
    resetSandboxDetection();
    broker = new ProcessBroker("off");
  });

  afterEach(() => {
    broker.killAll();
  });

  describe("registry", () => {
    it("lists a running child with the kind that asked for it", async () => {
      const p = await broker.spawn({
        kind: "shell",
        command: "/bin/bash",
        args: ["-c", "sleep 30"],
        cwd: process.cwd(),
        label: "sleep 30",
      });

      const entries = broker.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.kind).toBe("shell");
      expect(entries[0]!.label).toBe("sleep 30");
      expect(entries[0]!.pid).toBe(p.child.pid);
    });

    it("forgets a child once it exits", async () => {
      await broker.spawn({
        kind: "shell",
        command: "/bin/bash",
        args: ["-c", "exit 0"],
        cwd: process.cwd(),
      });

      expect(await until(() => broker.list().length === 0)).toBe(true);
    });

    it("killAll reaps every live child", async () => {
      const a = await broker.spawn({
        kind: "shell",
        command: "/bin/bash",
        args: ["-c", "sleep 30"],
        cwd: process.cwd(),
      });
      const b = await broker.spawn({
        kind: "hook",
        command: "/bin/bash",
        args: ["-c", "sleep 30"],
        cwd: process.cwd(),
      });

      expect(broker.killAll()).toBe(2);

      expect(await until(() => !alive(a.child.pid!) && !alive(b.child.pid!))).toBe(true);
    });
  });

  describe("cancellation", () => {
    it("kill() reaps the tree, not just the child", async () => {
      const p = await broker.spawn({
        kind: "shell",
        command: "/bin/bash",
        args: ["-c", 'sleep 300 & echo "$!"; wait'],
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      });

      const grandchild = await new Promise<number>((resolve, reject) => {
        p.child.stdout!.on("data", (c: Buffer) => {
          const line = c.toString("utf8").trim().split("\n")[0];
          if (line && /^\d+$/.test(line)) resolve(Number(line));
        });
        setTimeout(() => reject(new Error("no pid reported")), 5_000);
      });

      expect(alive(grandchild)).toBe(true);
      p.kill();
      expect(await until(() => !alive(grandchild))).toBe(true);
    });
  });

  describe("isolation policy", () => {
    it("refuses to spawn when require cannot be satisfied", async () => {
      // No isolation exists on darwin, and CI's linux image may or may not
      // have bwrap — so assert against whatever this host actually offers
      // rather than assuming. Where isolation IS available, "require" is
      // satisfiable and there is nothing to refuse.
      const strict = new ProcessBroker("require");
      const { mode } = await strict.effectiveIsolation();

      if (mode === "none") {
        await expect(
          strict.spawn({
            kind: "shell",
            command: "/bin/bash",
            args: ["-c", "exit 0"],
            cwd: process.cwd(),
          }),
        ).rejects.toBeInstanceOf(IsolationUnavailableError);
        expect(strict.list()).toHaveLength(0);
      } else {
        const p = await strict.spawn({
          kind: "shell",
          command: "/bin/bash",
          args: ["-c", "exit 0"],
          cwd: process.cwd(),
        });
        expect(p.isolation).toBe(mode);
        strict.killAll();
      }
    });

    it("refuses from a cold cache rather than downgrading", async () => {
      // The removed sync path failed exactly here: with detection not yet run
      // it treated "unknown" as "unavailable" and spawned unconfined, ahead of
      // any policy check. The broker must await detection before deciding.
      resetSandboxDetection();
      const strict = new ProcessBroker("require");
      const { mode } = await strict.effectiveIsolation();

      resetSandboxDetection(); // cold again, as at process start
      const attempt = strict.spawn({
        kind: "shell-session",
        command: "/bin/bash",
        args: ["-c", "exit 0"],
        cwd: process.cwd(),
      });

      if (mode === "none") {
        await expect(attempt).rejects.toBeInstanceOf(IsolationUnavailableError);
      } else {
        (await attempt).kill();
      }
    });

    it("reports isolation honestly rather than what was requested", async () => {
      const p = await broker.spawn({
        kind: "shell",
        command: "/bin/bash",
        args: ["-c", "sleep 5"],
        cwd: process.cwd(),
      });

      // Policy "off" means no isolation was even attempted, and the report
      // must say so instead of echoing a mode the child does not have.
      expect(p.isolation).toBe("none");
      expect(broker.list()[0]!.isolation).toBe("none");
    });
  });

  describe("process-wide default", () => {
    afterEach(() => {
      setProcessBroker(new ProcessBroker());
    });

    it("returns a stable instance", () => {
      expect(getProcessBroker()).toBe(getProcessBroker());
    });

    it("can be replaced for tests", () => {
      const replacement = new ProcessBroker("off");
      setProcessBroker(replacement);
      expect(getProcessBroker()).toBe(replacement);
    });
  });

  describe("exit reaping", () => {
    it("adds no exit listener until something is spawned", () => {
      const once = vi.spyOn(process, "once");
      new ProcessBroker("off");

      // Constructing a broker must have no global effect; a CLI that builds
      // one to ask a question should not thereby install a hook.
      expect(once).not.toHaveBeenCalledWith("exit", expect.any(Function));
      once.mockRestore();
    });

    it("shares one exit listener across brokers", async () => {
      // One listener per broker leaks: replacing the process-wide broker
      // leaves the old one's listener installed for the life of the process,
      // and enough replacements trip Node's own leak warning.
      const before = process.listenerCount("exit");

      const first = new ProcessBroker("off");
      const second = new ProcessBroker("off");
      const spawnSleep = (b: ProcessBroker) =>
        b.spawn({
          kind: "shell",
          command: "/bin/bash",
          args: ["-c", "sleep 5"],
          cwd: process.cwd(),
        });

      await spawnSleep(first);
      await spawnSleep(first);
      await spawnSleep(second);

      expect(process.listenerCount("exit")).toBeLessThanOrEqual(before + 1);

      first.killAll();
      second.killAll();
    });
  });
});
