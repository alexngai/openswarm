/**
 * team.ts — implementation of `openswarm team start <template>`.
 *
 * v0.4 stage 4F: minimal CLI surface that loads an openteams template,
 * maps it to a TeamSpec, and runs it through the Orchestrator. Full CLI
 * surface (`team send`, `team list`, `team stop`, `--map`) lands in 4K.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import type { PermissionMode } from "../core/types.js";
import { Orchestrator, type HostObserver } from "../swarm/orchestrator.js";
import { loadTemplate } from "../swarm/openteams/loader.js";
import { openteamsToTeamSpec } from "../swarm/openteams/mapping.js";
import { createMapSidecar, type MapSidecar } from "../host/map-sidecar.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import { TeamSpecSchema, type TeamSpec, type TopologyKind } from "../swarm/team-spec.js";
import { computeTeamPaths, teamsBaseDir } from "./team-paths.js";
import { attachLaneTrace } from "./trace-output.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TeamStartOptions {
  readonly permissionMode: PermissionMode;
  readonly concurrency: number;
  /** Results JSONL file. Default upstream of here: ./results.jsonl */
  readonly output: string;
  /** Override openteams binary (testing). */
  readonly openteamsBinary?: string;
  /** Read template from a fixture dir instead of shelling out (testing). */
  readonly fixtureDir?: string;
  /**
   * When set, the orchestrator attaches a MAP-sidecar-backed observer that
   * registers agents + forwards lifecycle events to an OpenHive hub at this
   * WS URL. Off when undefined. Uses the same outbound path as `host
   * --map-server`, so a hub sees identical event shapes from either entry point.
   */
  readonly mapUrl?: string;
  /**
   * v0.5 stage 5E.3: when true, fork a per-team daemon and return 0 once the
   * socket binds. Sync (default) behavior is byte-identical to v0.4.
   */
  readonly detach?: boolean;
}

// ---------------------------------------------------------------------------
// runTeamStart
// ---------------------------------------------------------------------------

export async function runTeamStart(
  templateName: string,
  opts: TeamStartOptions,
): Promise<number> {
  // 1. Load openteams template.
  let config;
  try {
    config = await loadTemplate(templateName, {
      ...(opts.openteamsBinary !== undefined && {
        openteamsBinary: opts.openteamsBinary,
      }),
      ...(opts.fixtureDir !== undefined && { fixtureDir: opts.fixtureDir }),
    });
  } catch (err) {
    process.stderr.write(
      `error: failed to load template "${templateName}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // 2. Map to TeamSpec.
  let spec;
  try {
    spec = openteamsToTeamSpec(config);
  } catch (err) {
    process.stderr.write(
      `error: failed to map template "${templateName}" to TeamSpec: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // 2a. v0.5 stage 5E.3: detach branch. Fork the per-team daemon and return
  //     once the socket binds. Sync (default) flow continues below unchanged.
  if (opts.detach === true) {
    return await detachAndForkDaemon(spec);
  }

  // 3. Optional MAP observability. Only constructed when `--map` was passed.
  // Routes through the shared outbound sidecar (same path as `host
  // --map-server`), so a hub sees identical OpenHive-typed event shapes.
  const observer =
    opts.mapUrl !== undefined
      ? makeMapObserver(opts.mapUrl, spec.name)
      : undefined;

  // 4. Open results stream + orchestrator.
  const resultsOut = fs.createWriteStream(opts.output, { flags: "a" });
  const orch = new Orchestrator({
    concurrency: opts.concurrency,
    permissionMode: opts.permissionMode,
    resultsOut,
    eventsOut: process.stderr,
    ...(observer !== undefined && { observer }),
  });

  // 5. Run.
  const startedAt = Date.now();
  const result = await orch.runTeam(spec);
  const elapsed = Date.now() - startedAt;

  await new Promise<void>((resolve) => resultsOut.end(resolve));

  process.stderr.write(
    `[openswarm] team "${spec.name}" complete in ${elapsed}ms: ` +
      `${result.succeeded} succeeded, ${result.failed} failed, ${result.timeout} timeout, ${result.cancelled} cancelled\n`,
  );
  if (result.aggregateOutput !== undefined) {
    process.stdout.write(`${result.aggregateOutput}\n`);
  }

  return result.failed > 0 || result.timeout > 0 || result.cancelled > 0
    ? 1
    : 0;
}

// ---------------------------------------------------------------------------
// MAP observability hook
// ---------------------------------------------------------------------------

/**
 * Build a {@link HostObserver} that, on start, dials the configured MAP/OpenHive
 * hub via the shared outbound sidecar and bridges the live host's agents +
 * lifecycle events to it. The sidecar owns the real `@multi-agent-protocol/sdk`
 * `AgentConnection` (typed, not duck-typed) and the OpenHive-typed event shapes,
 * so `team start --map` and `host --map-server` are wire-identical.
 *
 * Scope keeps the historical `swarm:<team>:<pid>` form so two harness processes
 * orchestrating the same team name don't collide on a shared hub. Connection
 * failure degrades to "no outbound MAP" (createMapSidecar returns undefined) —
 * observability must never fail a run.
 */
function makeMapObserver(url: string, teamName: string): HostObserver {
  const scope = `swarm:${teamName}:${process.pid}`;
  let sidecar: MapSidecar | undefined;
  return {
    async start(host) {
      sidecar = await createMapSidecar({
        host,
        server: url,
        scope,
        log: (m) => process.stderr.write(`${m}\n`),
      });
    },
    async stop() {
      await sidecar?.close().catch(() => {});
      sidecar = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// runTopology (v0.4 stage 4K)
// ---------------------------------------------------------------------------

export interface TopologyRunOptions {
  readonly topologyKind: TopologyKind;
  readonly specPath: string;
  readonly permissionMode: PermissionMode;
  readonly concurrency: number;
  /** Results JSONL file. */
  readonly output: string;
  /** Optional MAP/OpenHive observability URL (same path as `host --map-server`). */
  readonly mapUrl?: string;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  /** Default worker model for members without an explicit member.model. */
  readonly modelId?: string;
  /** Raw lane-event JSONL trace path. */
  readonly traceOutput?: string;
  /**
   * Test-only injection of a constructed Orchestrator. When set, runTopology
   * skips its own Orchestrator construction and calls `orch.runTeam(spec)`.
   * Used by team.test.ts to assert dispatch without spinning up workers.
   */
  readonly orchestrator?: Pick<Orchestrator, "runTeam">;
}

/**
 * Direct topology entry point: read a TeamSpec JSON file, override its
 * `topology` field with the CLI-provided kind, and run it through the
 * orchestrator. Mirrors the result-line writing pattern of `team start`.
 */
export async function runTopology(opts: TopologyRunOptions): Promise<number> {
  // 1. Read + parse spec.json.
  let raw: string;
  try {
    raw = await fsp.readFile(opts.specPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `error: failed to read spec file "${opts.specPath}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `error: spec file "${opts.specPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // Override `topology` with the CLI kind so a generic spec can be run as
  // any topology shape.
  const overlaid =
    typeof parsedJson === "object" && parsedJson !== null
      ? { ...(parsedJson as Record<string, unknown>), topology: opts.topologyKind }
      : parsedJson;

  const parseResult = TeamSpecSchema.safeParse(overlaid);
  if (!parseResult.success) {
    process.stderr.write(
      `error: spec file "${opts.specPath}" failed schema validation: ${parseResult.error.message}\n`,
    );
    return 2;
  }
  const parsedSpec = parseResult.data as TeamSpec;
  const spec =
    opts.modelId === undefined
      ? parsedSpec
      : {
          ...parsedSpec,
          members: parsedSpec.members.map((member) =>
            member.model === undefined
              ? { ...member, model: opts.modelId }
              : member,
          ),
        };

  // Test path: caller injected an orchestrator stub. Run + return early.
  if (opts.orchestrator !== undefined) {
    const result = await opts.orchestrator.runTeam(spec);
    return result.failed > 0 || result.timeout > 0 || result.cancelled > 0
      ? 1
      : 0;
  }

  // 2. Optional MAP observability (mirrors team start — shared sidecar path).
  const observer =
    opts.mapUrl !== undefined
      ? makeMapObserver(opts.mapUrl, spec.name)
      : undefined;

  // 3. Open results stream + orchestrator.
  const resultsOut = fs.createWriteStream(opts.output, { flags: "a" });
  const host = new StandaloneHost({ permissionMode: opts.permissionMode });
  const traceRecorder = attachLaneTrace(host, opts.traceOutput);
  const orch = new Orchestrator({
    concurrency: opts.concurrency,
    permissionMode: opts.permissionMode,
    resultsOut,
    eventsOut: process.stderr,
    host,
    ...(observer !== undefined && { observer }),
  });

  // 4. Run.
  const startedAt = Date.now();
  let result;
  let elapsed;
  try {
    result = await orch.runTeam(spec);
    elapsed = Date.now() - startedAt;
  } finally {
    await traceRecorder?.close();
    await new Promise<void>((resolve) => resultsOut.end(resolve));
  }

  process.stderr.write(
    `[openswarm] topology ${opts.topologyKind} "${spec.name}" complete in ${elapsed}ms: ` +
      `${result.succeeded} succeeded, ${result.failed} failed, ${result.timeout} timeout, ${result.cancelled} cancelled\n`,
  );
  if (result.aggregateOutput !== undefined) {
    process.stdout.write(`${result.aggregateOutput}\n`);
  }

  return result.failed > 0 || result.timeout > 0 || result.cancelled > 0
    ? 1
    : 0;
}

// ---------------------------------------------------------------------------
// detachAndForkDaemon — v0.5 stage 5E.3
//
// Fork team-daemon-entry (re-exec ourselves with --team-daemon) so the team
// outlives the parent shell. Wait up to 2s for the daemon's socket to bind
// before returning success. On startup failure the daemon's stdio log is
// dumped to stderr so the operator can see what went wrong.
// ---------------------------------------------------------------------------

// Path computation moved to ./team-paths.ts (shared with team list/send/stop/
// kill + team logs). The shared module owns the V0.5 stage 5E follow-up
// fallback for darwin's 104-char Unix socket sun_path limit.

async function tryConnect(sockPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(sockPath, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function detachAndForkDaemon(spec: TeamSpec): Promise<number> {
  const paths = computeTeamPaths(spec.name);
  await fsp.mkdir(paths.dir, { recursive: true });

  // Write the spec where the forked daemon will read it.
  await fsp.writeFile(paths.specPath, JSON.stringify(spec));

  // Open log fd shared by stdout + stderr of the daemon. The daemon's own
  // events.jsonl writer (5E.5) is independent of this — daemon.log captures
  // startup errors and any stray writes the daemon does to its own stdio.
  const logHandle = await fsp.open(paths.logPath, "a");

  // Re-exec ourselves with --team-daemon. process.argv[1] is the path to the
  // CLI bundle (dist/cli.js or similar). The daemon reads everything from env.
  const cliPath = process.argv[1];
  if (cliPath === undefined) {
    process.stderr.write(
      "error: --detach requires process.argv[1] to be the swarm-harness CLI path\n",
    );
    await logHandle.close();
    return 2;
  }

  const child = child_process.spawn(
    process.execPath,
    [cliPath, "--team-daemon"],
    {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: {
        ...process.env,
        SWARM_HARNESS_DAEMON_SPEC: paths.specPath,
        SWARM_HARNESS_DAEMON_SOCK: paths.sockPath,
        SWARM_HARNESS_DAEMON_PID: paths.pidPath,
        SWARM_HARNESS_DAEMON_EVENTS: paths.eventsPath,
        SWARM_HARNESS_DAEMON_STATE: paths.statePath,
      },
    },
  );

  // The child has its own copy of the fd; we can release the parent's handle.
  await logHandle.close();
  child.unref();

  // Retry connect for up to 2s. Each iteration: 250ms sleep, then attempt.
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (child.exitCode !== null && child.exitCode !== 0) {
      // Daemon exited early — surface its log.
      const log = await fsp.readFile(paths.logPath, "utf8").catch(() => "");
      process.stderr.write(
        `error: team daemon exited early (code ${child.exitCode})\n` +
          (log.length > 0 ? `daemon log:\n${log}\n` : ""),
      );
      return 2;
    }
    if (await tryConnect(paths.sockPath)) {
      process.stderr.write(
        `[openswarm] team "${spec.name}" started (pid ${child.pid}, socket ${paths.sockPath})\n`,
      );
      return 0;
    }
  }

  // Timeout — daemon didn't bind in 2s. Dump log + exit non-zero.
  const log = await fsp.readFile(paths.logPath, "utf8").catch(() => "");
  process.stderr.write(
    `error: team daemon did not bind socket within 2s (pid ${child.pid})\n` +
      `inspect: ${paths.logPath}\n` +
      (log.length > 0 ? `\nlog tail:\n${log}\n` : ""),
  );
  return 2;
}

// ---------------------------------------------------------------------------
// team send / list / stop / kill — v0.5 stage 5E.4
//
// Each command talks to a running per-team daemon (5E.2 / 5E.3) over its
// Unix socket. `team list` walks the teams directory directly (no socket).
// ---------------------------------------------------------------------------

/**
 * Connect to a team daemon's socket, send one RPC, await one response. Caller
 * picks the request id; the function resolves with the parsed response or
 * `null` on transport failure.
 */
async function rpcOnce(
  sockPath: string,
  request: { kind: "request"; id: string; method: string; params: unknown },
  timeoutMs = 3000,
): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } | null> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.once("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(buf.slice(0, idx)) as
          | { kind: "response"; id: string; ok: true; result: unknown }
          | { kind: "response"; id: string; ok: false; error: { code: string; message: string } };
        socket.end();
        if (parsed.kind === "response" && parsed.id === request.id) {
          resolve(parsed.ok ? { ok: true, result: parsed.result } : { ok: false, error: parsed.error });
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// teamsBaseDir + teamPaths(name) → use the shared computeTeamPaths utility
// from ./team-paths.ts so the CLI client and the daemon agree on the
// (possibly hash-shortened) socket location.

function teamPaths(name: string): { sockPath: string; pidPath: string } {
  const p = computeTeamPaths(name);
  return { sockPath: p.sockPath, pidPath: p.pidPath };
}

async function readDaemonPid(pidPath: string): Promise<number | null> {
  try {
    const raw = await fsp.readFile(pidPath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function runTeamSend(name: string, prompt: string): Promise<number> {
  const { sockPath } = teamPaths(name);
  const resp = await rpcOnce(sockPath, {
    kind: "request",
    id: `cli-send-${Date.now()}`,
    method: "send_prompt",
    params: { prompt },
  });
  if (resp === null) {
    process.stderr.write(
      `error: team "${name}" not running, or daemon unreachable at ${sockPath}.\n`,
    );
    return 2;
  }
  if (!resp.ok) {
    process.stderr.write(
      `error: team send rejected (${resp.error.code}): ${resp.error.message}\n`,
    );
    return 2;
  }
  process.stdout.write(`team "${name}" send_prompt acknowledged.\n`);
  return 0;
}

export async function runTeamList(): Promise<number> {
  const base = teamsBaseDir();
  let entries: string[];
  try {
    entries = await fsp.readdir(base);
  } catch {
    process.stdout.write("(no running teams)\n");
    return 0;
  }
  const live: Array<{ name: string; pid: number }> = [];
  for (const name of entries) {
    const { pidPath } = teamPaths(name);
    const pid = await readDaemonPid(pidPath);
    if (pid !== null && isProcessAlive(pid)) {
      live.push({ name, pid });
    }
  }
  if (live.length === 0) {
    process.stdout.write("(no running teams)\n");
    return 0;
  }
  process.stdout.write("NAME\tPID\n");
  for (const { name, pid } of live) {
    process.stdout.write(`${name}\t${pid}\n`);
  }
  return 0;
}

export async function runTeamStop(name: string): Promise<number> {
  const { sockPath, pidPath } = teamPaths(name);
  const resp = await rpcOnce(sockPath, {
    kind: "request",
    id: `cli-stop-${Date.now()}`,
    method: "stop",
    params: {},
  });
  if (resp === null) {
    process.stderr.write(
      `error: team "${name}" not running, or daemon unreachable at ${sockPath}.\n`,
    );
    return 2;
  }
  if (!resp.ok) {
    process.stderr.write(
      `error: team stop rejected (${resp.error.code}): ${resp.error.message}\n`,
    );
    return 2;
  }
  // Wait up to ~30s for the daemon process to actually exit (graceful drain
  // can take time if in-flight workers are still mid-task).
  const pid = await readDaemonPid(pidPath);
  if (pid !== null) {
    for (let i = 0; i < 60; i++) {
      if (!isProcessAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  process.stdout.write(`team "${name}" stopped.\n`);
  return 0;
}

export async function runTeamKill(name: string): Promise<number> {
  const { sockPath, pidPath } = teamPaths(name);
  const resp = await rpcOnce(sockPath, {
    kind: "request",
    id: `cli-kill-${Date.now()}`,
    method: "kill",
    params: {},
  });
  // For kill we tolerate transport errors — fall back to SIGKILL via pid file.
  const pid = await readDaemonPid(pidPath);

  if (resp === null) {
    if (pid === null || !isProcessAlive(pid)) {
      process.stdout.write(`team "${name}" was not running.\n`);
      return 0;
    }
    // Daemon unresponsive — SIGKILL directly.
    try {
      process.kill(pid, "SIGKILL");
      process.stdout.write(`team "${name}" killed via SIGKILL (pid ${pid}, daemon was unresponsive).\n`);
      return 0;
    } catch (err) {
      process.stderr.write(
        `error: failed to SIGKILL pid ${pid}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  }

  if (!resp.ok) {
    process.stderr.write(
      `error: team kill rejected (${resp.error.code}): ${resp.error.message}\n`,
    );
    return 2;
  }

  // Wait up to 5s; if still alive, escalate to SIGKILL.
  if (pid !== null) {
    for (let i = 0; i < 10; i++) {
      if (!isProcessAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  process.stdout.write(`team "${name}" killed.\n`);
  return 0;
}
