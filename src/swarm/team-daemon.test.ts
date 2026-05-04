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
import {
  TeamDaemon,
  type TeamDaemonOrchestrator,
  type TeamDaemonPaths,
} from "./team-daemon.js";
import type { TeamSpec } from "./team-spec.js";
import type { TeamResult } from "./topologies-types.js";

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

  it("send_prompt / stop / kill return UNKNOWN_METHOD with a 5E.4 hint", async () => {
    daemon = new TeamDaemon({
      spec: fakeSpec(),
      paths,
      orchestrator: fakeOrch({ neverResolves: true }),
    });
    await daemon.start();

    for (const method of ["send_prompt", "stop", "kill"] as const) {
      const socket = net.createConnection(paths.sockPath);
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        JSON.stringify({
          kind: "request",
          id: `rpc-${method}`,
          method,
          params: { prompt: "x" },
        }) + "\n",
      );
      const response = (await readResponse(socket)) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("unknown_method");
      expect(response.error?.message).toMatch(/5E\.4/);
      socket.end();
    }
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
