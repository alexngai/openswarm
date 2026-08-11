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

  it("creates a session and returns metadata", async () => {
    mgr = new ShellSessionManager();
    const session = await mgr.create("/tmp");
    expect(session.id).toMatch(/^sh_\d+$/);
    expect(session.pid).toBeGreaterThan(0);
    expect(session.cwd).toBe("/tmp");
    expect(session.exited).toBe(false);
    expect(session.lastCommand).toBeNull();
    expect(session.totalStdoutBytes).toBe(0);
    expect(session.totalStderrBytes).toBe(0);
    expect(session.state).toBeNull();
  });

  it("tracks initial command in lastCommand", async () => {
    mgr = new ShellSessionManager();
    const session = await mgr.create("/tmp", "echo hello");
    expect(session.lastCommand).toBe("echo hello");
  });

  it("runs an initial command and captures output", async () => {
    mgr = new ShellSessionManager();
    const session = await mgr.create("/tmp", "echo hello-session");
    await sleep(500);

    const output = mgr.readOutput(session.id);
    expect(output).not.toBeNull();
    expect(output!.stdout).toContain("hello-session");
  });

  it("writeStdin sends input and produces output", async () => {
    mgr = new ShellSessionManager();
    const session = await mgr.create("/tmp");
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
    const session = await mgr.create("/tmp", "echo first");
    await sleep(500);

    const out1 = mgr.readOutput(session.id);
    expect(out1!.stdout).toContain("first");

    mgr.writeStdin(session.id, "echo second\n");
    await sleep(500);

    const out2 = mgr.readOutput(session.id);
    expect(out2!.stdout).toContain("second");
    expect(out2!.stdout).not.toContain("first");
  });

  it("list returns all sessions", async () => {
    mgr = new ShellSessionManager();
    await mgr.create("/tmp");
    await mgr.create("/tmp");
    expect(mgr.list()).toHaveLength(2);
  });

  it("close removes a session", async () => {
    mgr = new ShellSessionManager();
    const s = await mgr.create("/tmp");
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
    const s = await mgr.create("/tmp");
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
    const s1 = await mgr.create("/tmp");
    await sleep(50);
    const s2 = await mgr.create("/tmp");
    await sleep(50);

    const s3 = await mgr.create("/tmp");
    expect(mgr.size).toBe(2);
    expect(mgr.get(s1.id)).toBeNull();
    expect(mgr.get(s2.id)).not.toBeNull();
    expect(mgr.get(s3.id)).not.toBeNull();
  });

  it("writeStdin returns false for exited session", async () => {
    mgr = new ShellSessionManager();
    const s = await mgr.create("/tmp", "exit 0");
    await sleep(500);

    expect(mgr.writeStdin(s.id, "test\n")).toBe(false);
  });

  it("readOutput returns null for unknown session", () => {
    mgr = new ShellSessionManager();
    expect(mgr.readOutput("nonexistent")).toBeNull();
  });

  it("tracks exit code", async () => {
    mgr = new ShellSessionManager();
    const s = await mgr.create("/tmp", "exit 42");
    await sleep(500);

    const session = mgr.get(s.id);
    expect(session!.exited).toBe(true);
    expect(session!.exitCode).toBe(42);
  });

  it("closeAll removes everything", async () => {
    mgr = new ShellSessionManager();
    await mgr.create("/tmp");
    await mgr.create("/tmp");
    await mgr.create("/tmp");
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

    it("updateState updates session cwd and state", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp");
      expect(s.cwd).toBe("/tmp");

      mgr.updateState(s.id, { cwd: "/home", env: {}, shellOpts: "" });
      const updated = mgr.get(s.id);
      expect(updated!.cwd).toBe("/home");
      expect(updated!.state!.cwd).toBe("/home");
    });

    it("setLastCommand updates lastCommand", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp");
      mgr.setLastCommand(s.id, "npm test");
      expect(mgr.get(s.id)!.lastCommand).toBe("npm test");
    });

    it("injectStateProbe returns false when captureState disabled", async () => {
      mgr = new ShellSessionManager({ captureState: false });
      const s = await mgr.create("/tmp");
      expect(mgr.injectStateProbe(s.id)).toBe(false);
    });
  });

  // F15: lifecycle management tests
  describe("lifecycle management (F15)", () => {
    it("tracks totalStdoutBytes", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp", "echo hello");
      await sleep(500);
      const session = mgr.get(s.id);
      expect(session!.totalStdoutBytes).toBeGreaterThan(0);
    });

    it("tracks lastAccessedAt", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp");
      const t1 = mgr.get(s.id)!.lastAccessedAt;
      await sleep(50);
      mgr.get(s.id); // access again
      const t2 = mgr.get(s.id)!.lastAccessedAt;
      expect(t2).toBeGreaterThanOrEqual(t1);
    });

    it("readAllOutput returns everything from the beginning", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp", "echo first");
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

    it("snapshot includes all metadata fields", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp", "echo test");
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

  describe("output retention is bounded (WP-04)", () => {
    // A session outlives its commands, so anything it holds it holds for a
    // long time. These are about the buffer, not the reported text: the read
    // path already truncated what callers see, while the buffer behind it grew
    // without limit.

    it("keeps reporting total bytes produced after discarding the middle", async () => {
      mgr = new ShellSessionManager();
      // ~2 MiB, well past the retention window at each end.
      const s = await mgr.create("/tmp", "for i in $(seq 1 20000); do echo 0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789; done");
      await sleep(2000);

      const listed = mgr.list().find((x) => x.id === s.id)!;
      expect(listed.totalStdoutBytes).toBeGreaterThan(1_000_000);
    }, 20_000);

    it("returns head and tail of a session that outran the window", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp", "echo FIRSTLINE; for i in $(seq 1 20000); do echo 01234567890123456789012345678901234567890123456789012345678901234567890123456789; done; echo LASTLINE");
      await sleep(2000);

      const all = mgr.readAllOutput(s.id)!;
      // Both ends survive even though the middle is long gone, which is the
      // same shape the read path produced before — now decided while reading.
      expect(all.stdout).toContain("FIRSTLINE");
      expect(all.stdout).toContain("LASTLINE");
    }, 20_000);

    it("stops holding output a reader has already drained", async () => {
      mgr = new ShellSessionManager();
      const s = await mgr.create("/tmp", "echo one");
      await sleep(500);

      const first = mgr.readOutput(s.id)!;
      expect(first.stdout).toContain("one");

      // The previous implementation advanced a cursor and left the bytes in
      // place, so a drained session never shrank. A second read must now see
      // nothing rather than the same bytes again.
      const second = mgr.readOutput(s.id)!;
      expect(second.stdout).toBe("");
    });
  });
});
