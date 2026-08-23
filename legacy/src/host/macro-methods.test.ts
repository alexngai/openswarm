import { describe, it, expect, vi } from "vitest";
import { createMacroMethods } from "./macro-methods.js";
import type { StandaloneHost } from "../swarm/standalone-host.js";
import type { AgentHandle } from "../swarm/host.js";

/** docs/44 P8 — _macro/spawnAgent + _macro/terminateAgent handlers. */

function fakeHandle(agentId: string): AgentHandle & { killSpy: ReturnType<typeof vi.fn> } {
  const killSpy = vi.fn(async () => {});
  return {
    agentId: agentId as never,
    sessionId: agentId as never,
    wait: () => new Promise(() => {}), // never resolves (long-lived)
    kill: killSpy,
    events: async function* () {},
    runMore: async () => ({ status: "success", output: "", wallClockMs: 0 }) as never,
    drain: async () => {},
    killSpy,
  } as never;
}

function fakeHost(spawn: ReturnType<typeof vi.fn>): StandaloneHost {
  return { spawn } as unknown as StandaloneHost;
}

describe("_macro/spawnAgent", () => {
  it("spawns a coordinator and returns its agent id", async () => {
    const handle = fakeHandle("agent-1");
    const spawn = vi.fn(async () => handle);
    const macro = createMacroMethods({
      host: fakeHost(spawn),
      defaultCwd: "/work",
      permissionMode: "workspace-write",
      log: () => {},
    });

    const res = (await macro.handlers["_macro/spawnAgent"]!(
      { task: "build the thing", role: "coordinator" },
      undefined,
    )) as { agent: { id: string; role: string } };

    expect(res.agent.id).toBe("agent-1");
    expect(res.agent.role).toBe("coordinator");
    const call = spawn.mock.calls[0]![0] as {
      task: { prompt: string; role: string };
      cwd: string;
      longLived: boolean;
      permissionMode: string;
    };
    expect(call.task.prompt).toBe("build the thing");
    expect(call.cwd).toBe("/work");
    expect(call.longLived).toBe(true);
    expect(call.permissionMode).toBe("workspace-write");
  });

  it("defaults role=coordinator and a generic prompt", async () => {
    const spawn = vi.fn(async () => fakeHandle("a2"));
    const macro = createMacroMethods({
      host: fakeHost(spawn),
      defaultCwd: "/w",
      permissionMode: "read-only",
      log: () => {},
    });
    await macro.handlers["_macro/spawnAgent"]!({}, undefined);
    const call = spawn.mock.calls[0]![0] as { task: { role: string }; permissionMode: string };
    expect(call.task.role).toBe("coordinator");
    expect(call.permissionMode).toBe("read-only");
  });

  it("honors a caller-supplied permissionMode + cwd + model", async () => {
    const spawn = vi.fn(async () => fakeHandle("a3"));
    const macro = createMacroMethods({
      host: fakeHost(spawn),
      defaultCwd: "/w",
      permissionMode: "workspace-write",
      log: () => {},
    });
    await macro.handlers["_macro/spawnAgent"]!(
      { permissionMode: "danger-full-access", cwd: "/other", model: "sonnet" },
      undefined,
    );
    const call = spawn.mock.calls[0]![0] as { permissionMode: string; cwd: string; model: string };
    expect(call.permissionMode).toBe("danger-full-access");
    expect(call.cwd).toBe("/other");
    expect(call.model).toBe("sonnet");
  });
});

describe("_macro/terminateAgent", () => {
  it("kills a tracked agent", async () => {
    const handle = fakeHandle("agent-1");
    const macro = createMacroMethods({
      host: fakeHost(vi.fn(async () => handle)),
      defaultCwd: "/w",
      permissionMode: "workspace-write",
      log: () => {},
    });
    await macro.handlers["_macro/spawnAgent"]!({}, undefined);
    const res = (await macro.handlers["_macro/terminateAgent"]!(
      { agentId: "agent-1" },
      undefined,
    )) as { success: boolean };
    expect(res.success).toBe(true);
    expect(handle.killSpy).toHaveBeenCalledOnce();
  });

  it("errors on a missing agentId", async () => {
    const macro = createMacroMethods({
      host: fakeHost(vi.fn()),
      defaultCwd: "/w",
      permissionMode: "workspace-write",
      log: () => {},
    });
    const res = (await macro.handlers["_macro/terminateAgent"]!({}, undefined)) as {
      success: boolean;
      error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/agentId is required/);
  });

  it("errors on an unknown agent", async () => {
    const macro = createMacroMethods({
      host: fakeHost(vi.fn()),
      defaultCwd: "/w",
      permissionMode: "workspace-write",
      log: () => {},
    });
    const res = (await macro.handlers["_macro/terminateAgent"]!(
      { agentId: "nope" },
      undefined,
    )) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown agent/);
  });
});

describe("dispose", () => {
  it("kills every spawned agent", async () => {
    const h1 = fakeHandle("a1");
    const h2 = fakeHandle("a2");
    const handles = [h1, h2];
    let i = 0;
    const macro = createMacroMethods({
      host: fakeHost(vi.fn(async () => handles[i++]!)),
      defaultCwd: "/w",
      permissionMode: "workspace-write",
      log: () => {},
    });
    await macro.handlers["_macro/spawnAgent"]!({}, undefined);
    await macro.handlers["_macro/spawnAgent"]!({}, undefined);
    await macro.dispose();
    expect(h1.killSpy).toHaveBeenCalledOnce();
    expect(h2.killSpy).toHaveBeenCalledOnce();
  });
});
