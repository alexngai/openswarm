import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "./standalone-host.js";
import { TeamSession } from "./team-session.js";
import type { AgentId } from "../core/types.js";
import { encodeFrame } from "./ipc/framing.js";
import type { SpawnWorkerArgs } from "./subprocess-spawner.js";

// ---------------------------------------------------------------------------
// Helpers — fake-spawn pattern lifted from standalone-host.test.ts.
// Each fake child has its own stdout PassThrough so multiple parallel spawns
// don't interleave on a shared stream.
// ---------------------------------------------------------------------------

function fakeProcPair(): {
  child: ChildProcess;
  emitFromWorker: (frame: object) => void;
  killSpy: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();

  const killSpy = vi.fn((signal?: string) => {
    emitter.emit("close", null, signal ?? null);
  });

  const child = Object.assign(emitter, {
    stdout,
    stdin,
    stderr: null,
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: killSpy,
  }) as unknown as ChildProcess;

  function emitFromWorker(frame: object): void {
    stdout.push(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
  }

  return { child, emitFromWorker, killSpy };
}

/**
 * Install a permissive spawnFn on the host: each spawn returns a fresh fake
 * child and auto-acks worker_ready + a successful task_result on next ticks
 * so spawn() resolves cleanly. Returns the array of spawned pairs (in spawn
 * order) so tests can assert kill() and similar side-effects.
 */
function installAutoSpawn(host: StandaloneHost): {
  pairs: ReturnType<typeof fakeProcPair>[];
} {
  const pairs: ReturnType<typeof fakeProcPair>[] = [];
  (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
    _args: SpawnWorkerArgs,
  ) => {
    const pair = fakeProcPair();
    pairs.push(pair);
    setImmediate(() => {
      pair.emitFromWorker({
        kind: "notification",
        method: "worker_ready",
        params: {},
      });
      setImmediate(() => {
        pair.emitFromWorker({
          kind: "notification",
          method: "task_result",
          params: {
            status: "success",
            output: "done",
            usage: { inputTokens: 0, outputTokens: 0 },
            wallClockMs: 0,
          },
        });
      });
    });
    return pair.child;
  };
  return { pairs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamSession", () => {
  it("construction: scope and members initialised", () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });
    expect(team.name).toBe("alpha");
    expect(team.scope).toBe("swarm:alpha");
    expect(team.members.size).toBe(0);
    expect(team.roles.size).toBe(0);
  });

  it("spawnMember registers child under team scope on the host", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const handle = await team.spawnMember({
      role: "executor",
      prompt: "do the thing",
    });

    expect(host.scopeOf(handle.agentId)).toBe("swarm:alpha");
    expect(team.members.size).toBe(1);
    const info = team.members.get(handle.agentId);
    expect(info).toBeDefined();
    expect(info!.role).toBe("executor");
    expect(info!.state).toBe("running");
  });

  it("spawnMember threads spec.cwd through to the spawner", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    const seen: SpawnWorkerArgs[] = [];
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      args: SpawnWorkerArgs,
    ) => {
      seen.push(args);
      const pair = fakeProcPair();
      setImmediate(() => {
        pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: { status: "success", output: "done", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 0 },
          });
        });
      });
      return pair.child;
    };
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    await team.spawnMember({ role: "lead", prompt: "go", cwd: "/work/project" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cwd).toBe("/work/project");
  });

  it("spawnMember threads spec.model through to the spawner", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    const seen: SpawnWorkerArgs[] = [];
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      args: SpawnWorkerArgs,
    ) => {
      seen.push(args);
      const pair = fakeProcPair();
      setImmediate(() => {
        pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: { status: "success", output: "done", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 0 },
          });
        });
      });
      return pair.child;
    };
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    await team.spawnMember({
      role: "executor",
      prompt: "go",
      model: "litellm/qwen3.6-35b-a3b",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe("litellm/qwen3.6-35b-a3b");
  });

  it("spawnMember threads spec.framework through to the spawner (Phase 2.2)", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    const seen: SpawnWorkerArgs[] = [];
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      args: SpawnWorkerArgs,
    ) => {
      seen.push(args);
      const pair = fakeProcPair();
      setImmediate(() => {
        pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: { status: "success", output: "done", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 0 },
          });
        });
      });
      return pair.child;
    };
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    await team.spawnMember({
      role: "executor",
      prompt: "go",
      model: "gpt-5.5",
      framework: "hardened-native",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.framework).toBe("hardened-native");
  });


  it("spawnAll spawns members in parallel; roles aggregate correctly", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const handles = await team.spawnAll([
      { role: "executor", prompt: "p1" },
      { role: "executor", prompt: "p2" },
      { role: "reviewer", prompt: "p3" },
    ]);

    expect(handles).toHaveLength(3);
    expect(team.members.size).toBe(3);

    for (const h of handles) {
      expect(host.scopeOf(h.agentId)).toBe("swarm:alpha");
    }

    const roles = team.roles;
    expect(roles.size).toBe(2);
    expect(roles.get("executor")).toHaveLength(2);
    expect(roles.get("reviewer")).toHaveLength(1);
  });

  it("scope isolation: broadcast `*` from team-alpha does not reach team-beta", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);

    const teamA = new TeamSession({
      name: "team-alpha",
      host,
      permissionMode: "workspace-write",
    });
    const teamB = new TeamSession({
      name: "team-beta",
      host,
      permissionMode: "workspace-write",
    });

    const alphaReviewer = await teamA.spawnMember({
      role: "reviewer",
      prompt: "review",
    });
    const alphaPeer = await teamA.spawnMember({
      role: "executor",
      prompt: "exec",
    });
    const betaReviewer = await teamB.spawnMember({
      role: "reviewer",
      prompt: "review",
    });

    expect(host.scopeOf(alphaReviewer.agentId)).toBe("swarm:team-alpha");
    expect(host.scopeOf(alphaPeer.agentId)).toBe("swarm:team-alpha");
    expect(host.scopeOf(betaReviewer.agentId)).toBe("swarm:team-beta");

    const result = await teamA.send(
      alphaReviewer.agentId,
      "*",
      "broadcast within alpha",
    );

    // Only alphaPeer is in team-alpha and not the sender → delivered=1.
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(1);
  });

  it("dispose kills every member's handle (best-effort)", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const h1 = await team.spawnMember({ role: "executor", prompt: "a" });
    const h2 = await team.spawnMember({ role: "executor", prompt: "b" });

    // Wrap each handle's kill so we can assert dispose called it. The
    // host-returned handle.kill closes the transport; we additionally count
    // here.
    const k1 = vi.spyOn(h1, "kill");
    const k2 = vi.spyOn(h2, "kill");

    await team.dispose();

    expect(k1).toHaveBeenCalledTimes(1);
    expect(k2).toHaveBeenCalledTimes(1);
    // Members map cleared after dispose.
    expect(team.members.size).toBe(0);
  });

  it("dispose is idempotent; second call is a no-op", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const h = await team.spawnMember({ role: "executor", prompt: "a" });
    const killSpy = vi.spyOn(h, "kill");

    await team.dispose();
    await team.dispose(); // second call should not re-kill.

    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("spawnMember after dispose throws", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    await team.dispose();

    await expect(
      team.spawnMember({ role: "executor", prompt: "a" }),
    ).rejects.toThrow(/cannot spawn after dispose/);
  });

  // -------------------------------------------------------------------------
  // v0.4 stage 4M (M1): stable memberId is registered with the host and
  // surfaced via team_members().
  // -------------------------------------------------------------------------

  it("spawnMember registers stable memberId; two members with same role get distinct ids", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const h1 = await team.spawnMember({
      id: "executor-a",
      role: "executor",
      prompt: "p1",
    });
    const h2 = await team.spawnMember({
      role: "executor", // no explicit id; gets auto-generated
      prompt: "p2",
    });

    // Explicit id round-trips.
    expect(host.memberIdOf(h1.agentId)).toBe("executor-a");
    // Auto-generated id is non-empty and distinct from the agentId.
    const m2 = host.memberIdOf(h2.agentId);
    expect(m2).toBeDefined();
    expect(m2).not.toBe(h2.agentId);
    expect(m2).not.toBe("executor-a");

    // listMembersInScope returns the stable memberIds, not agentIds.
    const members = host.listMembersInScope("swarm:alpha");
    const ids = members.map((m) => m.memberId).sort();
    expect(ids).toContain("executor-a");
    expect(ids).toContain(m2!);
    // Confirm the agentId column is still populated independently.
    for (const m of members) {
      expect(typeof m.agentId).toBe("string");
      expect(m.role).toBe("executor");
    }
  });

  // -------------------------------------------------------------------------
  // v0.4 stage 4M (M2): spawnAll partial-failure cleanup — kills successful
  // partials before re-throwing, so we don't leak orphan workers.
  // -------------------------------------------------------------------------

  it("spawnAll partial-failure: kills successful partials before re-throwing", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const pairs: ReturnType<typeof fakeProcPair>[] = [];
    let spawnCount = 0;
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      _args: SpawnWorkerArgs,
    ) => {
      spawnCount++;
      // The 2nd spawn throws synchronously to simulate a spawn failure
      // (e.g. resource limit, role unknown). Other spawns succeed normally.
      if (spawnCount === 2) {
        throw new Error("boom");
      }
      const pair = fakeProcPair();
      pairs.push(pair);
      setImmediate(() => {
        pair.emitFromWorker({
          kind: "notification",
          method: "worker_ready",
          params: {},
        });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: {
              status: "success",
              output: "done",
              usage: { inputTokens: 0, outputTokens: 0 },
              wallClockMs: 0,
            },
          });
        });
      });
      return pair.child;
    };

    await expect(
      team.spawnAll([
        { role: "executor", prompt: "p1" },
        { role: "executor", prompt: "p2" }, // throws
        { role: "reviewer", prompt: "p3" },
      ]),
    ).rejects.toThrow(/boom/);

    // Successful partials (1st and 3rd) had kill() called on them.
    expect(pairs).toHaveLength(2);
    for (const p of pairs) {
      expect(p.killSpy).toHaveBeenCalled();
    }
  });

  // -------------------------------------------------------------------------
  // v0.4 stage 4M (B3): worker_spawned / worker_exited lane events fire on
  // the host bus, so MAP adapter (and any other observer) sees agent
  // lifecycle in production runs.
  // -------------------------------------------------------------------------

  it("emits worker_spawned and worker_exited lane events on real spawn lifecycle", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    installAutoSpawn(host);
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    const bus = (host as unknown as { events: EventEmitter }).events;
    bus.on("lane_event", (e: { type: string; payload: unknown }) => {
      events.push({ type: e.type, payload: e.payload });
    });

    const handle = await team.spawnMember({
      role: "executor",
      prompt: "do",
    });

    // worker_spawned fires after the child is wired and the handle is built.
    const spawned = events.find((e) => e.type === "worker_spawned");
    expect(spawned).toBeDefined();
    const sp = spawned!.payload as {
      childAgentId: string;
      role?: string;
      teamScope?: string;
    };
    expect(sp.childAgentId).toBe(handle.agentId);
    expect(sp.role).toBe("executor");
    expect(sp.teamScope).toBe("swarm:alpha");

    // Trigger the close path by killing the worker; assert worker_exited fires.
    await handle.kill();
    // Allow microtasks to flush.
    await new Promise((r) => setImmediate(r));

    const exited = events.find((e) => e.type === "worker_exited");
    expect(exited).toBeDefined();
    const ex = exited!.payload as { agentId: string; exitCode: number | null };
    expect(ex.agentId).toBe(handle.agentId);
    // SIGTERM-induced exit emits null exitCode (signal-killed). MAP adapter
    // classifies this as failure per stage 4M (m1) — but the LANE event
    // here just records the raw value; the classification is at the adapter.
    expect(ex.exitCode === null || ex.exitCode === 0).toBe(true);
  });

  it("events() is a placeholder iterable that completes immediately (deferred to 4D)", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    const team = new TeamSession({
      name: "alpha",
      host,
      permissionMode: "workspace-write",
    });

    const collected: unknown[] = [];
    for await (const e of team.events()) {
      collected.push(e);
    }
    expect(collected).toEqual([]);
    // Suppress unused AgentId import lint when this test is the only consumer.
    void (null as unknown as AgentId);
  });
});
