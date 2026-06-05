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
    expect(session.lastCommand).toBeNull();
    expect(session.totalStdoutBytes).toBe(0);
    expect(session.totalStderrBytes).toBe(0);
    expect(session.state).toBeNull();
  });

  it("tracks initial command in lastCommand", () => {
    mgr = new ShellSessionManager();
    const session = mgr.create("/tmp", "echo hello");
    expect(session.lastCommand).toBe("echo hello");
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

  // F14: state snapshot tests
  describe("state snapshots (F14)", () => {
    it("extractState parses probe output", () => {
      mgr = new ShellSessionManager();
      const probeOutput =
        "__SWARM_STATE_PROBE__\n" +
        "CWD=/home/user\n" +
        "SHLVL=1\n" +
        "HOME=/home/user\n" +
        "OPTS=set +o emacs;set +o vi;\n" +
        "__SWARM_STATE_PROBE___END";

      const { cleaned, state } = mgr.extractState(probeOutput);
      expect(cleaned).toBe("");
      expect(state).not.toBeNull();
      expect(state!.cwd).toBe("/home/user");
      expect(state!.env.SHLVL).toBe("1");
      expect(state!.env.HOME).toBe("/home/user");
      expect(state!.shellOpts).toContain("emacs");
    });

    it("extractState strips probe from mixed output", () => {
      mgr = new ShellSessionManager();
      const mixed =
        "command output here\n" +
        "__SWARM_STATE_PROBE__\n" +
        "CWD=/tmp\n" +
        "__SWARM_STATE_PROBE___END\n" +
        "trailing output";

      const { cleaned, state } = mgr.extractState(mixed);
      expect(cleaned).toContain("command output here");
      expect(cleaned).toContain("trailing output");
      expect(cleaned).not.toContain("__SWARM_STATE_PROBE__");
      expect(state!.cwd).toBe("/tmp");
    });

    it("extractState returns null state when no probe found", () => {
      mgr = new ShellSessionManager();
      const { cleaned, state } = mgr.extractState("normal output");
      expect(cleaned).toBe("normal output");
      expect(state).toBeNull();
    });

    it("updateState updates session cwd and state", () => {
      mgr = new ShellSessionManager();
      const s = mgr.create("/tmp");
      expect(s.cwd).toBe("/tmp");

      mgr.updateState(s.id, { cwd: "/home", env: {}, shellOpts: "" });
      const updated = mgr.get(s.id);
      expect(updated!.cwd).toBe("/home");
      expect(updated!.state!.cwd).toBe("/home");
    });

    it("setLastCommand updates lastCommand", () => {
      mgr = new ShellSessionManager();
      const s = mgr.create("/tmp");
      mgr.setLastCommand(s.id, "npm test");
      expect(mgr.get(s.id)!.lastCommand).toBe("npm test");
    });

    it("injectStateProbe returns false when captureState disabled", () => {
      mgr = new ShellSessionManager({ captureState: false });
      const s = mgr.create("/tmp");
      expect(mgr.injectStateProbe(s.id)).toBe(false);
    });
  });

  // F15: lifecycle management tests
  describe("lifecycle management (F15)", () => {
    it("tracks totalStdoutBytes", async () => {
      mgr = new ShellSessionManager();
      const s = mgr.create("/tmp", "echo hello");
      await sleep(500);
      const session = mgr.get(s.id);
      expect(session!.totalStdoutBytes).toBeGreaterThan(0);
    });

    it("tracks lastAccessedAt", async () => {
      mgr = new ShellSessionManager();
      const s = mgr.create("/tmp");
      const t1 = mgr.get(s.id)!.lastAccessedAt;
      await sleep(50);
      mgr.get(s.id); // access again
      const t2 = mgr.get(s.id)!.lastAccessedAt;
      expect(t2).toBeGreaterThanOrEqual(t1);
    });

    it("readAllOutput returns everything from the beginning", async () => {
      mgr = new ShellSessionManager();
      const s = mgr.create("/tmp", "echo first");
      await sleep(500);

      // Consume first output.
      mgr.readOutput(s.id);

      mgr.writeStdin(s.id, "echo second\n");
      await sleep(500);

      // readAllOutput should include BOTH first and second.
      const all = mgr.readAllOutput(s.id);
      expect(all).not.toBeNull();
      expect(all!.stdout).toContain("first");
      expect(all!.stdout).toContain("second");
    });

    it("readAllOutput returns null for unknown session", () => {
      mgr = new ShellSessionManager();
      expect(mgr.readAllOutput("nonexistent")).toBeNull();
    });

    it("snapshot includes all metadata fields", () => {
      mgr = new ShellSessionManager();
      const s = mgr.create("/tmp", "echo test");
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("pid");
      expect(s).toHaveProperty("cwd");
      expect(s).toHaveProperty("startedAt");
      expect(s).toHaveProperty("lastAccessedAt");
      expect(s).toHaveProperty("totalStdoutBytes");
      expect(s).toHaveProperty("totalStderrBytes");
      expect(s).toHaveProperty("lastCommand");
      expect(s).toHaveProperty("state");
      expect(s).toHaveProperty("exitCode");
      expect(s).toHaveProperty("exited");
    });
  });
});
