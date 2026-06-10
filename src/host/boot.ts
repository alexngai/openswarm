/**
 * boot.ts — docs/44 P5 (H0). `bootSwarmHost` is swarm-harness's analog of
 * macro-agent's `bootV2`: it binds the OpenHive 3-port stride and stands up the
 * gateway/health server, returning a handle with `shutdown()`.
 *
 * Port layout (matches OpenHive's macro-agent-style adapter stride of 3):
 *   base      → ACP-over-WebSocket  `/acp`   (lands in P6)
 *   base + 1  → gateway / health    `/health`
 *   base + 2  → MAP server          `/map`   (lands in P7)
 *
 * P5 binds the health server and resolves the bootstrap contract. The ACP-WS
 * (P6) and MAP (P7) servers slot into the reserved ports later; the handle
 * already exposes their port numbers so callers can advertise the full layout.
 */

import type { PermissionMode } from "../core/types.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import { createHealthServer, type HealthServer } from "./health.js";
import { readBootstrapConfig, type BootstrapConfig } from "./bootstrap.js";

export interface SwarmHostPorts {
  /** ACP-over-WebSocket (`/acp`) — the endpoint OpenHive connects to. */
  readonly acp: number;
  /** Gateway / health HTTP (`/health`). */
  readonly health: number;
  /** MAP server (`/map`). */
  readonly map: number;
}

export interface SwarmHostHandle {
  readonly host: StandaloneHost;
  readonly ports: SwarmHostPorts;
  readonly health: HealthServer;
  readonly bootstrap: BootstrapConfig;
  /** Stable id for this swarm (MAP swarm_id when known). */
  readonly swarmId: string | undefined;
  shutdown(): Promise<void>;
}

export interface BootSwarmHostOptions {
  /** Base port. Binds base / base+1 / base+2. */
  readonly port: number;
  /** Bind address (default 127.0.0.1). */
  readonly host?: string;
  /** Working directory for spawned agents (default process.cwd()). */
  readonly cwd?: string;
  /** Pre-resolved bootstrap config; defaults to `readBootstrapConfig()`. */
  readonly bootstrap?: BootstrapConfig;
  /** Default permission mode for the host (default workspace-write). */
  readonly permissionMode?: PermissionMode;
  /** Stable swarm id (MAP identity); also used as the host's agentId. */
  readonly swarmId?: string;
  /** Test seam: construct the StandaloneHost (default `new StandaloneHost(...)`). */
  readonly makeHost?: () => StandaloneHost;
  /** Structured log sink (default writes to process.stderr). */
  readonly log?: (msg: string) => void;
}

export async function bootSwarmHost(
  opts: BootSwarmHostOptions,
): Promise<SwarmHostHandle> {
  const base = opts.port;
  const bindHost = opts.host ?? "127.0.0.1";
  const cwd = opts.cwd ?? process.cwd();
  const bootstrap = opts.bootstrap ?? readBootstrapConfig();
  const log =
    opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const ports: SwarmHostPorts = {
    acp: base,
    health: base + 1,
    map: base + 2,
  };

  const standalone =
    opts.makeHost?.() ??
    new StandaloneHost({
      permissionMode: opts.permissionMode ?? "workspace-write",
      ...(opts.swarmId !== undefined && {
        agentId: opts.swarmId as unknown as import("../core/types.js").AgentId,
      }),
    });

  const startedAt = Date.now();
  const health = await createHealthServer({
    port: ports.health,
    host: bindHost,
    getStatus: () => ({
      ...(opts.swarmId !== undefined && { swarmId: opts.swarmId }),
      uptimeMs: Date.now() - startedAt,
      ports,
    }),
  });

  // P6 (ACP-WS on ports.acp) and P7 (MAP on ports.map) slot in here later.

  // Bootstrap coordinator (H0). The default coordinator becomes chat-ready over
  // ACP; until the ACP-WS server lands (P6) there's no transport to drive it,
  // so P5 resolves + records the intent rather than spawning a headless agent
  // with no client. Rehydrate-on-restart ("all") likewise wires with the
  // session store in P6/P8.
  if (bootstrap.coordinator) {
    const coordCwd = bootstrap.coordinatorCwd ?? cwd;
    log(
      `[swarm-host] bootstrap coordinator requested ` +
        `(cwd=${coordCwd}, rehydrate=${bootstrap.rehydrate}); ` +
        `agent wiring lands with ACP-WS (P6)`,
    );
  }

  log(
    `[swarm-host] listening host=${bindHost} ` +
      `acp=ws://${bindHost}:${ports.acp}/acp ` +
      `health=http://${bindHost}:${ports.health}/health ` +
      `map=ws://${bindHost}:${ports.map}/map`,
  );

  return {
    host: standalone,
    ports,
    health,
    bootstrap,
    swarmId: opts.swarmId,
    async shutdown(): Promise<void> {
      // StandaloneHost has no long-lived resources of its own yet — workers are
      // per-spawn subprocesses reaped via their handles (and the ACP-WS/MAP
      // servers, P6/P7, will register their own teardown here). P5 just stops
      // the health server.
      await health.close();
    },
  };
}
