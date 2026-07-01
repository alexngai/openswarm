/**
 * boot.ts — docs/44 P5 (H0). `bootSwarmHost` is openswarm's analog of
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

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { PermissionMode } from "../core/types.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import { createHealthServer, type HealthServer } from "./health.js";
import { readBootstrapConfig, type BootstrapConfig } from "./bootstrap.js";
import {
  createAcpWsServer,
  type AcpWsServer,
  type AcpConnection,
} from "./acp-ws-server.js";
import { createMapServer, type MapServer } from "./map-server.js";
import { bridgeHostToMap, inboundMapSink } from "./map-bridge.js";
import { createMacroMethods } from "./macro-methods.js";
import { registerCascadeActions } from "./cascade-actions.js";
import { createMapSidecar, type MapSidecar } from "./map-sidecar.js";
import { wireAcpOverMap, type AcpOverMap } from "./map-acp-bridge.js";
import type { CommonOpts } from "../cli/argv.js";

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
  /** ACP-over-WebSocket server (base port) — present when `acpFactory` was set. */
  readonly acp: AcpWsServer | undefined;
  /** MAP server (base+2) — present when `map` was enabled. */
  readonly mapServer: MapServer | undefined;
  /** Outbound MAP sidecar — present when `mapServer` (a hub URL) was configured. */
  readonly sidecar: MapSidecar | undefined;
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
  /**
   * Per-connection ACP agent factory (docs/44 P6). When set, an ACP-over-
   * WebSocket server is bound on the base port at `/acp`. Omitted → no ACP
   * server (P5 health-only host).
   */
  readonly acpFactory?: (conn: AgentSideConnection) => AcpConnection;
  /**
   * Enable the MAP server on base+2 (docs/44 P7). OpenHive's MAPClientManager
   * connects here; the host→MAP bridge registers agents + forwards lifecycle
   * events. Default off (P5/P6 hosts without it).
   */
  readonly map?: boolean;
  /**
   * docs/44 Case 2 — OUTBOUND MAP. When set to a hub WS URL, the swarm dials it
   * as a MAP agent (instead of/in addition to waiting to be dialed) and runs the
   * host→MAP bridge + cascade + ACP-over-MAP over that connection. Fires only on
   * explicit config, never on a bootstrap token alone.
   */
  readonly mapServer?: string;
  /** MAP scope for the outbound sidecar (default `swarm:<swarmId|default>`). */
  readonly mapScope?: string;
  /** Onboard token for a verified-auth hub (outbound). */
  readonly onboardToken?: string;
  /**
   * Hosted ACP coordinator-team options. When set alongside `mapServer`, live
   * ACP chat is served over the outbound MAP connection (ACP-over-MAP).
   */
  readonly acpTeamOpts?: CommonOpts;
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

  const standalone = opts.makeHost?.() ?? (await makeDefaultHost(cwd, opts));

  // docs/44 — restart hygiene ("rehydrate"). openswarm agents are ephemeral
  // task-runners (a reconnecting ACP client resumes the transcript via
  // session/load + the spine, P6), so there's no live agent tree to revive on
  // restart — but a crashed prior run can leave stale worker-state files. Scan
  // for orphans (non-terminal state, process dead) and clean them up so state
  // doesn't accumulate across restarts. Skipped under rehydrate:"none".
  if (
    bootstrap.rehydrate !== "none" &&
    typeof standalone.scanForOrphanWorkers === "function"
  ) {
    try {
      const orphans = standalone.scanForOrphanWorkers();
      if (orphans.length > 0) {
        const { removeWorkerState } = await import("../swarm/worker-state-file.js");
        for (const o of orphans) {
          log(
            `[swarm-host] orphan worker ${o.agentId} (state=${o.lifecycleState}, pid=${o.pid} dead) — cleaning up`,
          );
          removeWorkerState(o.agentId);
        }
      }
    } catch (err) {
      log(`[swarm-host] orphan scan failed: ${(err as Error).message}`);
    }
  }

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

  // ACP-over-WebSocket on the base port (P6). Bound only when a factory is
  // supplied; the health-only host (P5) omits it. P7 adds the MAP server on
  // ports.map alongside.
  let acp: AcpWsServer | undefined;
  if (opts.acpFactory !== undefined) {
    acp = await createAcpWsServer({
      port: ports.acp,
      host: bindHost,
      makeConnection: opts.acpFactory,
      log,
    });
  }

  // MAP server on base+2 (P7) + the host→MAP bridge + P8 control surface.
  let mapServer: MapServer | undefined;
  let mapBridgeDispose: (() => void) | undefined;
  let macroDispose: (() => Promise<void>) | undefined;
  if (opts.map === true) {
    // docs/44 P8 — `_macro/*` request handlers (spawn/terminate) + per-connection
    // cascade-action notifications, both driving the StandaloneHost / its
    // branch-policy adapter (Track A primitives).
    const macro = createMacroMethods({
      host: standalone,
      defaultCwd: cwd,
      permissionMode: opts.permissionMode ?? "workspace-write",
      log,
    });
    macroDispose = macro.dispose;
    mapServer = await createMapServer({
      port: ports.map,
      host: bindHost,
      ...(opts.swarmId !== undefined && { name: opts.swarmId }),
      additionalHandlers: macro.handlers,
      onConnection: (router) => {
        registerCascadeActions(router, {
          host: standalone,
          // mapServer is assigned before any connection can arrive.
          emit: (e) => mapServer!.map.emit(e),
          log,
        });
      },
      log,
    });
    mapBridgeDispose = bridgeHostToMap(standalone, inboundMapSink(mapServer), {
      ...(opts.swarmId !== undefined && { swarmId: opts.swarmId }),
      log,
    });
  }

  // docs/44 Case 2 — OUTBOUND MAP sidecar: dial a configured hub, register over
  // the connection, run the bridge + cascade + (optionally) ACP-over-MAP.
  let sidecar: MapSidecar | undefined;
  let acpOverMap: AcpOverMap | undefined;
  if (opts.mapServer !== undefined && opts.mapServer !== "") {
    const scope = opts.mapScope ?? `swarm:${opts.swarmId ?? "default"}`;
    sidecar = await createMapSidecar({
      host: standalone,
      server: opts.mapServer,
      scope,
      ...(opts.swarmId !== undefined && { swarmId: opts.swarmId }),
      ...(opts.onboardToken !== undefined && { credential: opts.onboardToken }),
      log,
    });
    if (sidecar !== undefined && opts.acpTeamOpts !== undefined) {
      // Live ACP chat over the outbound connection (the hub can't dial our
      // ACP-WS server in this topology).
      acpOverMap = wireAcpOverMap({
        connection: sidecar.connection,
        acpOpts: opts.acpTeamOpts,
        log,
      });
    }
  }

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
    acp,
    mapServer,
    sidecar,
    bootstrap,
    swarmId: opts.swarmId,
    async shutdown(): Promise<void> {
      // Tear down in reverse-dependency order: stop the bridge (no more events
      // onto a closing MAP server), then ACP/MAP servers (in-flight connections
      // dispose), then the health server (the keep-alive). StandaloneHost has no
      // long-lived resources of its own — workers are per-spawn subprocesses.
      if (acpOverMap !== undefined) await acpOverMap.close();
      if (sidecar !== undefined) await sidecar.close();
      mapBridgeDispose?.();
      if (macroDispose !== undefined) await macroDispose();
      if (acp !== undefined) await acp.close();
      if (mapServer !== undefined) await mapServer.close();
      await health.close();
    },
  };
}

/**
 * Construct the host's StandaloneHost. When `cwd` is a git repo (the OpenHive-
 * hosted workspace), attach a GitCascadeBranchPolicyAdapter so stream-based
 * landing + cascade actions (P8 merge/resolve) actually operate on git; outside
 * a repo we skip it and those paths degrade to "unsupported" gracefully.
 */
async function makeDefaultHost(
  cwd: string,
  opts: BootSwarmHostOptions,
): Promise<StandaloneHost> {
  const agentId =
    opts.swarmId !== undefined
      ? (opts.swarmId as unknown as import("../core/types.js").AgentId)
      : undefined;
  const permissionMode = opts.permissionMode ?? "workspace-write";

  const fs = await import("node:fs");
  const path = await import("node:path");
  const isGitRepo = fs.existsSync(path.join(cwd, ".git"));
  if (!isGitRepo) {
    return new StandaloneHost({
      permissionMode,
      ...(agentId !== undefined && { agentId }),
    });
  }

  const { GitCascadeBranchPolicyAdapter } = await import(
    "../swarm/adapters/git-cascade-branch-policy.js"
  );
  return new StandaloneHost({
    permissionMode,
    ...(agentId !== undefined && { agentId }),
    branchPolicyAdapter: new GitCascadeBranchPolicyAdapter({ repoPath: cwd }),
  });
}
