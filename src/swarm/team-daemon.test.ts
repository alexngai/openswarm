/**
 * Tests for src/swarm/team-daemon.ts — v0.5 stage 5E.2.
 *
 * In-process lifecycle tests for the TeamDaemon class. Verifies socket bind,
 * pid file management, stale-socket cleanup, status RPC, and the
 * not-yet-implemented-method response shape. Does not exercise the forked
 * CLI entry — that's covered by the smoke script in 5E.6.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Writable } from "node:stream";
import {
  TeamDaemon,
  type TeamDaemonOrchestrator,
  type TeamDaemonPaths,
} from "./team-daemon.js";
import type { TeamSpec } from "./team-spec.js";
import type { TeamResult } from "./topologies-types.js";
import type { MemberInfo, MemberState, TeamSession } from "./team-session.js";
import type { LaneEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tmpPaths(): TeamDaemonPaths {
  const dir = path.join(
    os.tmpdir(),
    `team-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return {
    sockPath: path.join(dir, "daemon.sock"),
    pidPath: path.join(dir, "daemon.pid"),
    eventsPath: path.join(dir, "events.jsonl"),
    statePath: path.join(dir, "state.json"),
    checkpointPath: path.join(dir, "checkpoint.json"),
  };
}

function fakeSpec(overrides: Partial<TeamSpec> = {}): TeamSpec {
  return {
    name: "smoke",
    topology: "fanout",
    members: [],
    coordination: { completion: { kind: "all" } },
    ...overrides,
  };
}

/**
 * Stub orchestrator that resolves runTeam with a quick TeamResult and never
 * spawns subprocess workers. Configure `runTeamDelay` to simulate in-flight
 * work; default holds the daemon open until stop() resolves it.
 */
function fakeOrch(opts: { neverResolves?: boolean } = {}): TeamDaemonOrchestrator {
  return {
    runTeam: async () => {
      if (opts.neverResolves) {
        await new Promise(() => {
          /* hold forever — caller stops the daemon */
        });
      }
      const result: TeamResult = {
        succeeded: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
      return result;
    },
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readResponse(socket: net.Socket, timeoutMs = 1500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("readResponse: timeout")), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch (err) {
          reject(err);
        }
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamDaemon — lifecycle", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = undefined;
    }
  });

  it("start binds the socket and writes pid + state files", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    expect(await fileExists(paths.sockPath)).toBe(true);
    expect(await fileExists(paths.pidPath)).toBe(true);
    expect(await fileExists(paths.statePath)).toBe(true);

    const pidStr = await fs.readFile(paths.pidPath, "utf8");
    expect(Number.parseInt(pidStr.trim(), 10)).toBe(process.pid);
  });

  it("stop closes the socket and removes pid + sock files", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    expect(await fileExists(paths.sockPath)).toBe(true);
    await daemon.stop();
    daemon = undefined;

    expect(await fileExists(paths.sockPath)).toBe(false);
    expect(await fileExists(paths.pidPath)).toBe(false);
  });

  it("stop is idempotent", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();
    await daemon.stop();
    await daemon.stop(); // must not throw
    daemon = undefined;
  });

  it("rejects start when called twice on the same instance", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();
    await expect(daemon.start()).rejects.toThrow(/already started/);
  });
});

describe("TeamDaemon — RPC handlers (5E.2 stub set)", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = undefined;
    }
  });

  it("status returns the team snapshot", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec({ name: "alpha", topology: "peer-team" }),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({
        kind: "request",
        id: "rpc-1",
        method: "status",
        params: {},
      }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      kind?: string;
      id?: string;
      ok?: boolean;
      result?: { teamName?: string; scope?: string; topology?: string };
    };

    expect(response.kind).toBe("response");
    expect(response.id).toBe("rpc-1");
    expect(response.ok).toBe(true);
    expect(response.result?.teamName).toBe("alpha");
    expect(response.result?.scope).toBe("swarm:alpha");
    expect(response.result?.topology).toBe("peer-team");
    socket.end();
  });

  it("send_prompt returns UNKNOWN_METHOD when the orchestrator doesn't expose getActiveTeam (5F)", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({
        kind: "request",
        id: "rpc-send",
        method: "send_prompt",
        params: { prompt: "hi" },
      }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("unknown_method");
    expect(response.error?.message).toMatch(/getActiveTeam/);
    socket.end();
  });

  it("send_prompt spawns an ad-hoc member into the live TeamSession (5F)", async () => {
    // Stub orchestrator that exposes getActiveTeam returning a fake session
    // with a recording spawnMember.
    let spawnedSpec: { role?: string; prompt?: string } | undefined;
    const fakeTeam = {
      spawnMember: async (spec: { role?: string; prompt?: string }) => {
        spawnedSpec = spec;
        return {
          agentId: "ad-hoc-agent-id",
          sessionId: "ad-hoc-session",
          wait: async () => ({ status: "success" as const, output: "" } as never),
          kill: async () => {},
          events: async function* () {},
          runMore: async () => ({}) as never,
          drain: async () => {},
        };
      },
    } as unknown as import("./team-session.js").TeamSession;
    const orchestrator: TeamDaemonOrchestrator = {
      runTeam: async () => {
        await new Promise(() => {});
        return {
          succeeded: 0,
          failed: 0,
          timeout: 0,
          cancelled: 0,
          resultWriteFailures: 0,
          deadLetterViolation: false,
          deadLetterWriteFailures: 0,
        };
      },
      getActiveTeam: () => fakeTeam,
    };
    daemon = new TeamDaemon({
      spec: fakeSpec({
        members: [
          {
            id: "m1",
            role: "executor",
            prompt: "initial",
            branchPolicy: { kind: "none" },
            commitPolicy: { kind: "none" },
            escalationPolicy: { kind: "none" },
          },
        ],
      }),
      paths,
      orchestrator,
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({
        kind: "request",
        id: "rpc-send-ok",
        method: "send_prompt",
        params: { prompt: "follow up task" },
      }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      ok?: boolean;
      result?: { delivered?: number; recipients?: string[] };
    };
    expect(response.ok).toBe(true);
    expect(response.result?.delivered).toBe(1);
    expect(response.result?.recipients).toEqual(["ad-hoc-agent-id"]);
    // Ad-hoc member inherits role from spec[0]; prompt is the new payload.
    expect(spawnedSpec?.role).toBe("executor");
    expect(spawnedSpec?.prompt).toBe("follow up task");
    socket.end();
  });

  it("send_prompt returns UNKNOWN_METHOD when getActiveTeam returns undefined (5F)", async () => {
    const orchestrator: TeamDaemonOrchestrator = {
      runTeam: async () => {
        await new Promise(() => {});
        return {
          succeeded: 0,
          failed: 0,
          timeout: 0,
          cancelled: 0,
          resultWriteFailures: 0,
          deadLetterViolation: false,
          deadLetterWriteFailures: 0,
        };
      },
      getActiveTeam: () => undefined, // e.g. fanout topology — disposes after run
    };
    daemon = new TeamDaemon({ spec: fakeSpec(), paths, orchestrator });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({
        kind: "request",
        id: "rpc-send-no-team",
        method: "send_prompt",
        params: { prompt: "x" },
      }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("unknown_method");
    expect(response.error?.message).toMatch(/no live TeamSession/);
    socket.end();
  });

  it("stop returns acknowledged then tears down the daemon (5E.4)", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({
        kind: "request",
        id: "rpc-stop",
        method: "stop",
        params: {},
      }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      ok?: boolean;
      result?: { acknowledged?: boolean };
    };
    expect(response.ok).toBe(true);
    expect(response.result?.acknowledged).toBe(true);
    socket.end();

    // The daemon stops asynchronously via setImmediate; wait briefly then
    // assert the socket file is gone.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (!(await fileExists(paths.sockPath))) break;
    }
    expect(await fileExists(paths.sockPath)).toBe(false);
    daemon = undefined;
  });

  it("kill returns acknowledged + invokes processExit (5E.4)", async () => {
    let exitCode: number | undefined;
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
      processExit: (code) => {
        exitCode = code;
      },
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({
        kind: "request",
        id: "rpc-kill",
        method: "kill",
        params: {},
      }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      ok?: boolean;
      result?: { acknowledged?: boolean };
    };
    expect(response.ok).toBe(true);
    expect(response.result?.acknowledged).toBe(true);
    socket.end();

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (exitCode !== undefined) break;
    }
    expect(exitCode).toBe(0);
    daemon = undefined;
  });

  it("malformed JSON returns MALFORMED_FRAME", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("{not-json}\n");
    const response = (await readResponse(socket)) as {
      ok?: boolean;
      error?: { code?: string };
    };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("malformed_frame");
    socket.end();
  });
});

describe("TeamDaemon — events.jsonl writer (5E.5)", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = undefined;
    }
  });

  it("appends each subscribed event as a JSONL line to events.jsonl", async () => {
    type AnyHandler = (event: unknown) => void;
    let emit: AnyHandler | undefined;
    const orchestrator: TeamDaemonOrchestrator = {
      runTeam: async () => {
        await new Promise(() => {});
        return {
          succeeded: 0,
          failed: 0,
          timeout: 0,
          cancelled: 0,
          resultWriteFailures: 0,
          deadLetterViolation: false,
          deadLetterWriteFailures: 0,
        };
      },
      subscribeEvents: ((handler: AnyHandler) => {
        emit = handler;
        return () => {
          emit = undefined;
        };
      }) as TeamDaemonOrchestrator["subscribeEvents"],
    };
    daemon = new TeamDaemon({ spec: fakeSpec(), paths, orchestrator });
    await daemon.start();

    expect(emit).toBeDefined();
    emit!({ ts: 100, agentId: "a", type: "worker_spawned", payload: {} });
    emit!({ ts: 200, agentId: "a", type: "worker_exited", payload: {} });

    // Stop flushes the writer.
    await daemon.stop();
    daemon = undefined;

    const raw = await fs.readFile(paths.eventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    // Line 0 is the wire-protocol metadata event stamped on first open;
    // events follow.
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "_metadata",
      protocol_version: "1.0",
      producer: "team-daemon",
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ ts: 100, type: "worker_spawned" });
    expect(JSON.parse(lines[2]!)).toMatchObject({ ts: 200, type: "worker_exited" });
  });

  it("does NOT re-stamp the metadata header when restarting against an existing events.jsonl", async () => {
    type AnyHandler = (event: unknown) => void;
    const makeOrch = (): { orch: TeamDaemonOrchestrator; emitRef: { current?: AnyHandler } } => {
      const emitRef: { current?: AnyHandler } = {};
      const orch: TeamDaemonOrchestrator = {
        runTeam: async () => {
          await new Promise(() => {});
          return {
            succeeded: 0,
            failed: 0,
            timeout: 0,
            cancelled: 0,
            resultWriteFailures: 0,
            deadLetterViolation: false,
            deadLetterWriteFailures: 0,
          };
        },
        subscribeEvents: ((handler: AnyHandler) => {
          emitRef.current = handler;
          return () => {
            emitRef.current = undefined;
          };
        }) as TeamDaemonOrchestrator["subscribeEvents"],
      };
      return { orch, emitRef };
    };

    // First daemon — emits one event, then stops.
    const first = makeOrch();
    daemon = new TeamDaemon({ spec: fakeSpec(), paths, orchestrator: first.orch });
    await daemon.start();
    first.emitRef.current!({ ts: 100, agentId: "a", type: "worker_spawned", payload: {} });
    await daemon.stop();

    // Second daemon — same paths. Should append a second event without
    // writing another metadata header on top of the existing file.
    const second = makeOrch();
    daemon = new TeamDaemon({ spec: fakeSpec(), paths, orchestrator: second.orch });
    await daemon.start();
    second.emitRef.current!({ ts: 200, agentId: "a", type: "worker_exited", payload: {} });
    await daemon.stop();
    daemon = undefined;

    const raw = await fs.readFile(paths.eventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const metadataLines = lines.filter((l) => {
      try {
        return (JSON.parse(l) as { type?: string }).type === "_metadata";
      } catch {
        return false;
      }
    });
    expect(metadataLines).toHaveLength(1);
    expect(lines).toHaveLength(3); // metadata + 2 events across both daemons
  });

  it("drops live-only LaneEvents from events.jsonl but keeps recorded ones", async () => {
    type AnyHandler = (event: unknown) => void;
    let emit: AnyHandler | undefined;
    const orchestrator: TeamDaemonOrchestrator = {
      runTeam: async () => {
        await new Promise(() => {});
        return {
          succeeded: 0,
          failed: 0,
          timeout: 0,
          cancelled: 0,
          resultWriteFailures: 0,
          deadLetterViolation: false,
          deadLetterWriteFailures: 0,
        };
      },
      subscribeEvents: ((handler: AnyHandler) => {
        emit = handler;
        return () => {
          emit = undefined;
        };
      }) as TeamDaemonOrchestrator["subscribeEvents"],
    };
    daemon = new TeamDaemon({ spec: fakeSpec(), paths, orchestrator });
    await daemon.start();

    // Mix of live-only and recorded events. worker_lifecycle_changed is
    // recorded (it's the canonical typed state-transition record, not a
    // streaming delta) — only text_delta / tool_use_input / heartbeat are
    // dropped from disk.
    emit!({ ts: 10, agentId: "a", type: "worker_spawned", payload: {} });
    emit!({ ts: 11, agentId: "a", type: "text_delta", payload: {} }); // live-only — dropped
    emit!({ ts: 12, agentId: "a", type: "heartbeat", payload: {} }); // live-only — dropped
    emit!({ ts: 13, agentId: "a", type: "tool_use_input", payload: {} }); // live-only — dropped
    emit!({
      ts: 14,
      agentId: "a",
      type: "worker_lifecycle_changed",
      payload: {},
    }); // recorded — kept
    emit!({ ts: 15, agentId: "a", type: "tool_use_end", payload: {} }); // recorded
    emit!({ ts: 16, agentId: "a", type: "worker_exited", payload: {} });

    await daemon.stop();
    daemon = undefined;

    const raw = await fs.readFile(paths.eventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const records = lines.map((l) => JSON.parse(l) as { type: string });
    // Metadata + 4 recorded events; the 3 live-only events are dropped.
    expect(records).toHaveLength(5);
    expect(records[0]!.type).toBe("_metadata");
    expect(records.slice(1).map((r) => r.type)).toEqual([
      "worker_spawned",
      "worker_lifecycle_changed",
      "tool_use_end",
      "worker_exited",
    ]);
  });

  it("does not create events.jsonl when orchestrator omits subscribeEvents", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();
    expect(await fileExists(paths.eventsPath)).toBe(false);
  });

  it("unsubscribes events on stop (cleanup)", async () => {
    let unsubCalled = false;
    const orchestrator: TeamDaemonOrchestrator = {
      runTeam: async () => {
        await new Promise(() => {});
        return {
          succeeded: 0,
          failed: 0,
          timeout: 0,
          cancelled: 0,
          resultWriteFailures: 0,
          deadLetterViolation: false,
          deadLetterWriteFailures: 0,
        };
      },
      subscribeEvents: () => () => {
        unsubCalled = true;
      },
    };
    daemon = new TeamDaemon({ spec: fakeSpec(), paths, orchestrator });
    await daemon.start();
    await daemon.stop();
    daemon = undefined;
    expect(unsubCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 4.1 — status members, drain, config/startup notice
// ---------------------------------------------------------------------------

/** Build a fake TeamSession exposing a members map + recording handles. */
function fakeTeamWithMembers(
  members: Array<{
    agentId: string;
    state: MemberState;
    drain?: () => Promise<void>;
    wait?: () => Promise<unknown>;
    kill?: () => Promise<void>;
  }>,
): TeamSession {
  const map = new Map<string, MemberInfo>();
  for (const m of members) {
    map.set(m.agentId, {
      memberId: m.agentId,
      role: "executor",
      agentId: m.agentId,
      state: m.state,
      handle: {
        agentId: m.agentId,
        sessionId: m.agentId,
        wait: m.wait ?? (async () => ({ status: "success", output: "" })),
        kill: m.kill ?? (async () => {}),
        events: async function* () {},
        runMore: async () => ({}),
        drain: m.drain ?? (async () => {}),
      } as unknown as MemberInfo["handle"],
    });
  }
  return { members: map } as unknown as TeamSession;
}

function orchWithTeam(team: TeamSession | undefined): TeamDaemonOrchestrator {
  return {
    runTeam: async () => {
      await new Promise(() => {});
      return {
        succeeded: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
    },
    getActiveTeam: () => team,
  };
}

function captureWritable(): { out: Writable; text: () => string } {
  let buf = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { out, text: () => buf };
}

describe("TeamDaemon — Phase 4.1a live status members", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });
  afterEach(async () => {
    if (daemon) {
      await daemon.stop({ drainTimeoutMs: 0 }).catch(() => {});
      daemon = undefined;
    }
  });

  it("status reports real per-member state from the active team", async () => {
    const team = fakeTeamWithMembers([
      { agentId: "a1", state: "running" },
      { agentId: "a2", state: "idle" },
      { agentId: "a3", state: "finished" },
    ]);
    daemon = new TeamDaemon({
      spec: fakeSpec({ name: "live" }),
      paths,
      orchestrator: orchWithTeam(team),
      startupOut: captureWritable().out,
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({ kind: "request", id: "s1", method: "status", params: {} }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      result?: { members?: Array<{ agentId: string; state: string }> };
    };
    const byId = Object.fromEntries(
      (response.result?.members ?? []).map((m) => [m.agentId, m.state]),
    );
    expect(byId).toEqual({ a1: "running", a2: "idle", a3: "finished" });
    socket.end();
  });

  it("status reports an empty member list when no team is active", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: orchWithTeam(undefined),
      startupOut: captureWritable().out,
    });
    await daemon.start();

    const socket = net.createConnection(paths.sockPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      JSON.stringify({ kind: "request", id: "s2", method: "status", params: {} }) + "\n",
    );
    const response = (await readResponse(socket)) as {
      result?: { members?: unknown[] };
    };
    expect(response.result?.members).toEqual([]);
    socket.end();
  });
});

describe("TeamDaemon — Phase 4.1b worker drain on stop", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });
  afterEach(async () => {
    if (daemon) {
      await daemon.stop({ drainTimeoutMs: 0 }).catch(() => {});
      daemon = undefined;
    }
  });

  it("drains long-lived members (calls handle.drain) before teardown", async () => {
    let drained = false;
    const team = fakeTeamWithMembers([
      {
        agentId: "a1",
        state: "running",
        drain: async () => {
          drained = true;
        },
      },
    ]);
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: orchWithTeam(team),
      startupOut: captureWritable().out,
    });
    await daemon.start();
    await daemon.stop();
    daemon = undefined;
    expect(drained).toBe(true);
  });

  it("falls back to awaiting wait() when a member is not long-lived (drain rejects)", async () => {
    let waited = false;
    const team = fakeTeamWithMembers([
      {
        agentId: "a1",
        state: "running",
        drain: async () => {
          throw new Error("not long-lived");
        },
        wait: async () => {
          waited = true;
          return { status: "success", output: "" };
        },
      },
    ]);
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: orchWithTeam(team),
      startupOut: captureWritable().out,
    });
    await daemon.start();
    await daemon.stop();
    daemon = undefined;
    expect(waited).toBe(true);
  });

  it("force-kills members still live after the drain deadline", async () => {
    let killed = false;
    const team = fakeTeamWithMembers([
      {
        agentId: "a1",
        state: "running",
        drain: () => new Promise<void>(() => {}), // never resolves
        wait: () => new Promise(() => {}),
        kill: async () => {
          killed = true;
        },
      },
    ]);
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: orchWithTeam(team),
      startupOut: captureWritable().out,
    });
    await daemon.start();
    await daemon.stop({ drainTimeoutMs: 20 });
    daemon = undefined;
    expect(killed).toBe(true);
  });

  it("skips the cooperative drain entirely when drainTimeoutMs is 0 (kill path)", async () => {
    let drained = false;
    let waited = false;
    const team = fakeTeamWithMembers([
      {
        agentId: "a1",
        state: "running",
        drain: async () => {
          drained = true;
        },
        wait: async () => {
          waited = true;
          return { status: "success", output: "" };
        },
      },
    ]);
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: orchWithTeam(team),
      startupOut: captureWritable().out,
    });
    await daemon.start();
    await daemon.stop({ drainTimeoutMs: 0 });
    daemon = undefined;
    expect(drained).toBe(false);
    expect(waited).toBe(false);
  });

  it("does not drain members already in a terminal state", async () => {
    let drained = false;
    const team = fakeTeamWithMembers([
      {
        agentId: "a1",
        state: "finished",
        drain: async () => {
          drained = true;
        },
      },
    ]);
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: orchWithTeam(team),
      startupOut: captureWritable().out,
    });
    await daemon.start();
    await daemon.stop();
    daemon = undefined;
    expect(drained).toBe(false);
  });
});

describe("TeamDaemon — Phase 4.1c startup notice", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });
  afterEach(async () => {
    if (daemon) {
      await daemon.stop({ drainTimeoutMs: 0 }).catch(() => {});
      daemon = undefined;
    }
  });

  it("writes effective permissionMode + concurrency to the startup sink", async () => {
    const cap = captureWritable();
    daemon = new TeamDaemon({
      spec: fakeSpec({ name: "cfg", topology: "peer-team" }),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
      permissionMode: "read-only",
      concurrency: 4,
      startupOut: cap.out,
    });
    await daemon.start();
    expect(cap.text()).toMatch(
      /team "cfg" daemon ready.*permissionMode=read-only concurrency=4/,
    );
  });

  it("warns when spawn-resolver is selected below danger-full-access", async () => {
    const cap = captureWritable();
    daemon = new TeamDaemon({
      spec: fakeSpec({
        name: "resolv",
        members: [
          {
            role: "executor",
            prompt: "p",
            onConflict: "spawn-resolver",
          },
        ],
      }),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
      permissionMode: "workspace-write",
      startupOut: cap.out,
    });
    await daemon.start();
    expect(cap.text()).toMatch(/spawn-resolver.*below danger-full-access/);
  });

  it("does not warn about spawn-resolver at danger-full-access", async () => {
    const cap = captureWritable();
    daemon = new TeamDaemon({
      spec: fakeSpec({
        members: [{ role: "executor", prompt: "p", onConflict: "spawn-resolver" }],
      }),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
      permissionMode: "danger-full-access",
      startupOut: cap.out,
    });
    await daemon.start();
    expect(cap.text()).not.toMatch(/spawn-resolver/);
  });
});

describe("TeamDaemon — stale-socket + duplicate-name (V0.5.Q5b + Q7)", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = undefined;
    }
  });

  it("rejects start when a live daemon already owns the socket (Q7)", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    const dup = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await expect(dup.start()).rejects.toThrow(/already running/);
  });

  it("cleans up a stale socket left by a dead process (Q5b)", async () => {
    // Plant a stale socket file + a pid file pointing at a non-existent pid.
    await fs.mkdir(path.dirname(paths.sockPath), { recursive: true });
    await fs.writeFile(paths.sockPath, "");
    await fs.writeFile(paths.pidPath, "999999");
    expect(await fileExists(paths.sockPath)).toBe(true);

    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start(); // must NOT throw — stale socket cleaned

    expect(await fileExists(paths.sockPath)).toBe(true);
    const pidStr = await fs.readFile(paths.pidPath, "utf8");
    expect(Number.parseInt(pidStr.trim(), 10)).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// GitHub #17 — per-member + team usage in the status snapshot
// ---------------------------------------------------------------------------

type LaneHandler = (event: LaneEvent) => void;

/** Orchestrator exposing both a live team AND a capturable event stream. */
function orchWithTeamAndEvents(
  team: TeamSession,
  onSubscribe: (handler: LaneHandler) => void,
): TeamDaemonOrchestrator {
  return {
    runTeam: async () => {
      await new Promise(() => {});
      return {
        succeeded: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
    },
    getActiveTeam: () => team,
    subscribeEvents: ((handler: LaneHandler) => {
      onSubscribe(handler);
      return () => {};
    }) as TeamDaemonOrchestrator["subscribeEvents"],
  };
}

async function requestStatus(sockPath: string): Promise<{
  members?: Array<{ agentId: string; usage?: { totalTokens: number; costUsd: number } }>;
  teamUsage?: { totalTokens: number; costUsd: number };
}> {
  const socket = net.createConnection(sockPath);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    JSON.stringify({ kind: "request", id: "u1", method: "status", params: {} }) + "\n",
  );
  const response = (await readResponse(socket)) as {
    result?: {
      members?: Array<{ agentId: string; usage?: { totalTokens: number; costUsd: number } }>;
      teamUsage?: { totalTokens: number; costUsd: number };
    };
  };
  socket.end();
  return response.result ?? {};
}

describe("TeamDaemon — GitHub #17 usage aggregation in status", () => {
  let paths: TeamDaemonPaths;
  let daemon: TeamDaemon | undefined;

  beforeEach(() => {
    paths = tmpPaths();
  });
  afterEach(async () => {
    if (daemon) {
      await daemon.stop({ drainTimeoutMs: 0 }).catch(() => {});
      daemon = undefined;
    }
  });

  it("attaches per-member subtree usage + a team total to the status snapshot", async () => {
    const team = fakeTeamWithMembers([
      { agentId: "root", state: "running" },
      { agentId: "peer", state: "running" },
    ]);
    let feed: LaneHandler = () => {};
    daemon = new TeamDaemon({
      spec: fakeSpec({ name: "usage" }),
      paths,
      orchestrator: orchWithTeamAndEvents(team, (h) => {
        feed = h;
      }),
      startupOut: captureWritable().out,
    });
    await daemon.start();

    // Top-level members are announced via worker_spawned (carrying model);
    // root then spawns a child. Each member + the child reports usage.
    feed({
      ts: 0,
      agentId: "orchestrator" as unknown as LaneEvent["agentId"],
      type: "worker_spawned",
      payload: { childAgentId: "root", model: "claude-sonnet-4-6" },
    });
    feed({
      ts: 1,
      agentId: "root" as unknown as LaneEvent["agentId"],
      type: "worker_spawned",
      payload: { childAgentId: "child", parentAgentId: "root", model: "claude-sonnet-4-6" },
    });
    feed({
      ts: 2,
      agentId: "root" as unknown as LaneEvent["agentId"],
      type: "message_stop",
      payload: { usage: { inputTokens: 1000, outputTokens: 0 } },
    });
    feed({
      ts: 3,
      agentId: "child" as unknown as LaneEvent["agentId"],
      type: "message_stop",
      payload: { usage: { inputTokens: 500, outputTokens: 0 } },
    });
    feed({
      ts: 4,
      agentId: "peer" as unknown as LaneEvent["agentId"],
      type: "message_stop",
      payload: { usage: { inputTokens: 200, outputTokens: 0 } },
    });

    const result = await requestStatus(paths.sockPath);
    const byId = Object.fromEntries(
      (result.members ?? []).map((m) => [m.agentId, m.usage]),
    );
    // root subtree = root(1000) + child(500)
    expect(byId["root"]?.totalTokens).toBe(1500);
    // both priced via sonnet: (1000 + 500) * 3.00 / 1e6
    expect(byId["root"]?.costUsd).toBeCloseTo(0.0045, 10);
    // peer only its own usage
    expect(byId["peer"]?.totalTokens).toBe(200);
    // team total = 1000 + 500 + 200
    expect(result.teamUsage?.totalTokens).toBe(1700);
  });

  it("reports zero usage before any message_stop is observed", async () => {
    const team = fakeTeamWithMembers([{ agentId: "a1", state: "running" }]);
    daemon = new TeamDaemon({
      spec: fakeSpec({ name: "zero" }),
      paths,
      orchestrator: orchWithTeamAndEvents(team, () => {}),
      startupOut: captureWritable().out,
    });
    await daemon.start();

    const result = await requestStatus(paths.sockPath);
    expect(result.members?.[0]?.usage?.totalTokens).toBe(0);
    expect(result.teamUsage?.totalTokens).toBe(0);
  });
});
