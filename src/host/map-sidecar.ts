/**
 * map-sidecar.ts — docs/44 Case 2. The OUTBOUND MAP connection: the swarm dials
 * a configured OpenHive destination and registers itself, rather than waiting to
 * be dialed (the inbound P7 server). This is how a standalone `swarm-harness
 * host` reaches a known hub.
 *
 * Models cc-swarm's `connectToMAP` (references/claude-code-swarm), but in-process
 * — our `host` is already a persistent daemon, so it holds the `AgentConnection`
 * directly with no separate sidecar process. The same host→MAP bridge (agent
 * registration + lifecycle events) and cascade-action dispatch as the inbound
 * server are reused over the connection; ACP-over-MAP (live chat) is wired
 * separately by the caller via `connection`.
 */

import { AgentConnection } from "@multi-agent-protocol/sdk";
import type { StandaloneHost } from "../swarm/standalone-host.js";
import { bridgeHostToMap, type MapSink } from "./map-bridge.js";
import { registerCascadeActions, type CascadeRouter } from "./cascade-actions.js";

export interface MapSidecarOptions {
  readonly host: StandaloneHost;
  /** Configured hub MAP WS URL (e.g. ws://localhost:7836). */
  readonly server: string;
  /** Scope identifier (e.g. `swarm:<id>`). */
  readonly scope: string;
  readonly swarmId?: string;
  readonly systemId?: string;
  /** Onboard token for verified-auth hubs (open hubs omit it). */
  readonly credential?: string;
  /** Test seam: override the connect (default `AgentConnection.connect`). */
  readonly connect?: (url: string, opts: unknown) => Promise<AgentConnection>;
  readonly log?: (msg: string) => void;
}

export interface MapSidecar {
  readonly scope: string;
  /** The live AgentConnection (for ACP-over-MAP wiring). */
  readonly connection: AgentConnection;
  close(): Promise<void>;
}

const CASCADE_ACTIONS = [
  "merge",
  "abandon",
  "pause",
  "resume",
  "resolve",
  "push",
  "commit",
] as const;

/** Pull the MAP-assigned id out of a spawn result, tolerating shape variance. */
function spawnResultId(res: unknown): string {
  const r = res as { agent?: { id?: string }; agentId?: string; id?: string };
  return r.agent?.id ?? r.agentId ?? r.id ?? "";
}

/**
 * Connect the swarm to a hub as a MAP agent and wire the host→MAP bridge +
 * cascade actions over the connection. Returns undefined (non-fatal) if the
 * SDK or the hub is unavailable — a hosted swarm degrades to "no outbound MAP"
 * rather than failing to boot.
 */
export async function createMapSidecar(
  opts: MapSidecarOptions,
): Promise<MapSidecar | undefined> {
  const log = opts.log ?? (() => {});
  const agentName = `${opts.scope.replace(/^swarm:/, "")}-sidecar`;

  const connectOpts = {
    name: agentName,
    role: "sidecar",
    scopes: [opts.scope],
    capabilities: {
      messaging: { canSend: true, canReceive: true },
      lifecycle: { canObserve: true },
      // We drive cascade actions on real git (P8) — advertise canAct.
      cascade: { canAct: true, emitsConflicts: true },
      // Layer 1: we report worker session trajectories to the hub.
      trajectory: { canReport: true },
    },
    metadata: {
      type: "swarm-harness-sidecar",
      ...(opts.swarmId !== undefined && { swarmId: opts.swarmId }),
      ...(opts.systemId !== undefined && { systemId: opts.systemId }),
    },
    reconnection: {
      enabled: true,
      maxRetries: 10,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    },
  } as const;

  let connection: AgentConnection;
  try {
    const AC = AgentConnection as unknown as {
      connect(url: string, o: unknown): Promise<AgentConnection>;
      createConnection?(url: string, o: unknown): Promise<AgentConnection>;
    };
    if (opts.connect !== undefined) {
      connection = await opts.connect(opts.server, connectOpts);
    } else if (
      opts.credential !== undefined &&
      typeof AC.createConnection === "function"
    ) {
      // Verified-auth hubs: connectOnly → authenticate → register.
      connection = await AC.createConnection(opts.server, connectOpts);
      const c = connection as unknown as {
        connectOnly(): Promise<{ authRequired?: { required?: boolean; methods?: string[] } }>;
        authenticate(o: { method: string; token: string }): Promise<{ success: boolean; error?: { message?: string } }>;
        register(): Promise<unknown>;
      };
      const res = await c.connectOnly();
      if (res.authRequired?.required) {
        const method = res.authRequired.methods?.[0] ?? "token";
        const auth = await c.authenticate({ method, token: opts.credential });
        if (!auth.success) {
          log(`[map-sidecar] auth failed: ${auth.error?.message ?? "unknown"}`);
          return undefined;
        }
      }
      await c.register();
    } else {
      connection = await AC.connect(opts.server, connectOpts);
    }
  } catch (err) {
    log(`[map-sidecar] connect failed: ${(err as Error).message}`);
    return undefined;
  }

  // Outbound sink: register agents as children of the sidecar; broadcast events
  // to the scope. Mirrors the inbound sink's contract (map-bridge.ts).
  const conn = connection as unknown as {
    spawn(o: unknown): Promise<unknown>;
    send(to: unknown, payload?: unknown): Promise<unknown>;
    callExtension?(method: string, params: unknown): Promise<unknown>;
    sendNotification?(method: string, params: unknown): Promise<void>;
    onNotification(method: string, handler: (params: unknown) => void): unknown;
    disconnect(reason?: string): Promise<unknown>;
  };

  // Cached trajectory resource id from the hub's first response — passed on
  // subsequent reports so the hub links them (mirrors cc-swarm sidecar-server).
  let trajectoryResourceId: string | undefined;

  const sink: MapSink = {
    registerAgent: async (spec) => {
      const res = await conn.spawn({
        name: spec.name,
        role: spec.role,
        scopes: [opts.scope],
        ...(spec.capabilities !== undefined && {
          capabilities: { protocols: spec.capabilities },
        }),
        ...(spec.metadata !== undefined && { metadata: spec.metadata }),
      });
      return { id: spawnResultId(res) || spec.name };
    },
    unregisterAgent: async (id) => {
      try {
        if (typeof conn.callExtension === "function") {
          await conn.callExtension("map/agents/unregister", { agentId: id });
        }
      } catch {
        // Best-effort — the hub also drops children on disconnect.
      }
    },
    emitEvent: async (event) => {
      try {
        await conn.send({ scope: opts.scope }, { type: event.type, data: event.data });
      } catch {
        // Best-effort observability.
      }
    },
    emitTrajectory: async (checkpoint) => {
      // Hub-push via the trajectory extension; fall back to a broadcast message
      // when the hub doesn't support it. Cache + replay the server resource_id.
      try {
        if (typeof conn.callExtension !== "function") {
          throw new Error("trajectory extension unavailable");
        }
        const params = {
          checkpoint,
          ...(trajectoryResourceId !== undefined && {
            resource_id: trajectoryResourceId,
          }),
        };
        const res = (await conn.callExtension(
          "trajectory/checkpoint",
          params,
        )) as { resource_id?: string } | undefined;
        if (res?.resource_id !== undefined) trajectoryResourceId = res.resource_id;
      } catch {
        try {
          await conn.send(
            { scope: opts.scope },
            { type: "trajectory.checkpoint", checkpoint },
          );
        } catch {
          // Best-effort.
        }
      }
    },
  };

  const bridgeDispose = bridgeHostToMap(opts.host, sink, {
    ...(opts.swarmId !== undefined && { swarmId: opts.swarmId }),
    log,
  });

  // Cascade actions arrive as `x-cascade/request.*` notifications down the
  // connection. Adapt the per-method onNotification into the catch-all router
  // registerCascadeActions expects, and reuse the P8 dispatch.
  const cascadeRouter: CascadeRouter = {
    onNotification(handler) {
      for (const action of CASCADE_ACTIONS) {
        const method = `x-cascade/request.${action}`;
        conn.onNotification(method, (params) => handler(method, params));
      }
    },
  };
  registerCascadeActions(cascadeRouter, {
    host: opts.host,
    emit: (e) => {
      void sink.emitEvent({ type: e.type, data: e.data });
    },
    log,
  });

  log(`[map-sidecar] connected to ${opts.server} as ${agentName} (scope ${opts.scope})`);

  return {
    scope: opts.scope,
    connection,
    async close(): Promise<void> {
      bridgeDispose();
      try {
        await conn.disconnect("shutdown");
      } catch {
        // Best-effort.
      }
    },
  };
}
