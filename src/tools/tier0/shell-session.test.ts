import { describe, it, expect, afterEach } from "vitest";
import { ShellSessionManager } from "./shell-session.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("ShellSessionManager", () => {
  let mgr: ShellSessionManager;

  afterEach(() => {
    mgr?.closeAll();
  });

  it("creates a session and returns metadata", () => {
    mgr = new ShellSessionManager();
    const session = mgr.create("/tmp");
    expect(session.id).toMatch(/^sh_\d+$/);
    expect(session.pid).toBeGreaterThan(0);
    expect(session.cwd).toBe("/tmp");
    expect(session.exited).toBe(false);
  });

  it("runs an initial command and captures output", async () => {
    mgr = new ShellSessionManager();
    const session = mgr.create("/tmp", "echo hello-session");
    await sleep(500);

    const output = mgr.readOutput(session.id);
    expect(output).not.toBeNull();
    expect(output!.stdout).toContain("hello-session");
  });

  it("writeStdin sends input and produces output", async () => {
    mgr = new ShellSessionManager();
    const session = mgr.create("/tmp");
    await sleep(300);
    mgr.readOutput(session.id); // drain startup noise

    mgr.writeStdin(session.id, "echo ws-test\n");
    await sleep(500);

    const output = mgr.readOutput(session.id);
    expect(output).not.toBeNull();
    expect(output!.stdout).toContain("ws-test");
  });

  it("readOutput returns only new data (cursor tracking)", async () => {
    mgr = new ShellSessionManager();
    const session = mgr.create("/tmp", "echo first");
    await sleep(500);

    const out1 = mgr.readOutput(session.id);
    expect(out1!.stdout).toContain("first");

    mgr.writeStdin(session.id, "echo second\n");
    await sleep(500);

    const out2 = mgr.readOutput(session.id);
    expect(out2!.stdout).toContain("second");
    expect(out2!.stdout).not.toContain("first");
  });

  it("list returns all sessions", () => {
    mgr = new ShellSessionManager();
    mgr.create("/tmp");
    mgr.create("/tmp");
    expect(mgr.list()).toHaveLength(2);
  });

  it("close removes a session", () => {
    mgr = new ShellSessionManager();
    const s = mgr.create("/tmp");
    expect(mgr.close(s.id)).toBe(true);
    expect(mgr.get(s.id)).toBeNull();
    expect(mgr.size).toBe(0);
  });

  it("close returns false for unknown session", () => {
    mgr = new ShellSessionManager();
    expect(mgr.close("nonexistent")).toBe(false);
  });

  it("signal sends SIGKILL to session and kills it", async () => {
    mgr = new ShellSessionManager();
    const s = mgr.create("/tmp");
    await sleep(300);

    expect(mgr.signal(s.id, "SIGKILL")).toBe(true);

    // Wait for the close event to propagate.
    for (let i = 0; i < 20; i++) {
      const session = mgr.get(s.id);
      if (session?.exited) break;
      await sleep(100);
    }

    const session = mgr.get(s.id);
    expect(session!.exited).toBe(true);
  });

  it("evicts LRU session when max reached", async () => {
    mgr = new ShellSessionManager({ maxSessions: 2 });
    const s1 = mgr.create("/tmp");
    await sleep(50);
    const s2 = mgr.create("/tmp");
    await sleep(50);

    // s1 is oldest; creating s3 should evict it.
    const s3 = mgr.create("/tmp");
    expect(mgr.size).toBe(2);
    expect(mgr.get(s1.id)).toBeNull();
    expect(mgr.get(s2.id)).not.toBeNull();
    expect(mgr.get(s3.id)).not.toBeNull();
  });

  it("writeStdin returns false for exited session", async () => {
    mgr = new ShellSessionManager();
    const s = mgr.create("/tmp", "exit 0");
    await sleep(500);

    expect(mgr.writeStdin(s.id, "test\n")).toBe(false);
  });

  it("readOutput returns null for unknown session", () => {
    mgr = new ShellSessionManager();
    expect(mgr.readOutput("nonexistent")).toBeNull();
  });

  it("tracks exit code", async () => {
    mgr = new ShellSessionManager();
    const s = mgr.create("/tmp", "exit 42");
    await sleep(500);

    const session = mgr.get(s.id);
    expect(session!.exited).toBe(true);
    expect(session!.exitCode).toBe(42);
  });

  it("closeAll removes everything", () => {
    mgr = new ShellSessionManager();
    mgr.create("/tmp");
    mgr.create("/tmp");
    mgr.create("/tmp");
    mgr.closeAll();
    expect(mgr.size).toBe(0);
  });
});
