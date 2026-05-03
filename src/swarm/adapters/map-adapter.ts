/**
 * map-adapter.ts — in-process MAP (Multi-Agent Protocol) adapter.
 *
 * v0.4 stage 4J: forwards a curated subset of lane events from the orchestrator
 * to an external MAP-protocol observer. Off by default — only constructed when
 * the CLI was invoked with `--map`. The adapter never imports the real
 * `@multi-agent-protocol/sdk`; it codes against the `MapClientFactory` shim
 * (see `map-protocol.ts`) so production wires the SDK and tests inject fakes.
 *
 * Forwarded events (per docs/25 §10.1 mapping table):
 *   worker_spawned        → swarm.agent.spawned
 *   worker_exited (ok)    → swarm.agent.completed
 *   worker_exited (fail)  → swarm.agent.failed
 *   task_created          → swarm.task.dispatched
 *   task_updated          → swarm.task.updated
 *   task_completed        → swarm.task.completed
 *   message_sent          → swarm.message.sent
 *   branch_lock_acquired  → swarm.branch.locked
 *   branch_lock_released  → swarm.branch.released
 *   team_started          → swarm.team.started
 *   team_completed        → swarm.team.completed
 *   team_aborted          → swarm.team.aborted
 *
 * Other lane events (turn_start, text_delta, tool_use_*, heartbeat, ...) are
 * NOT forwarded. They're high-volume internal events; v0.4 keeps the MAP
 * surface focused on lifecycle + coordination.
 */

import type { EventEmitter } from "node:events";
import type { LaneEvent } from "../events.js";
import type { StandaloneHost } from "../standalone-host.js";
import type {
  MapAgentConnection,
  MapClientFactory,
} from "./map-protocol.js";

export interface MapAdapterOptions {
  /** WebSocket URL of the MAP server (e.g. `ws://localhost:8080`). */
  readonly url: string;
  /** Team name; becomes part of the default scope. */
  readonly teamName: string;
  /**
   * Override the default scope-derivation. Per V0.4.Q7, default is
   * `swarm:<teamName>:<pid>` so two harness processes orchestrating the same
   * team name don't collide on a shared MAP server.
   */
  readonly scope?: string;
  /** Pluggable MAP client — production injects real SDK; tests inject fakes. */
  readonly factory: MapClientFactory;
  /** Optional: own agent name announced to MAP. Defaults to "swarm-harness". */
  readonly agentName?: string;
}

export class MapAdapter {
  private connection: MapAgentConnection | undefined;
  private host: StandaloneHost | undefined;
  private listener: ((event: LaneEvent) => void) | undefined;
  readonly url: string;
  readonly scope: string;
  private readonly factory: MapClientFactory;
  private readonly agentName: string;

  constructor(opts: MapAdapterOptions) {
    this.url = opts.url;
    this.scope = opts.scope ?? `swarm:${opts.teamName}:${process.pid}`;
    this.factory = opts.factory;
    this.agentName = opts.agentName ?? "swarm-harness";
  }

  /**
   * Connect to the MAP server and subscribe to the host's lane event bus.
   * Idempotent: a second start() with the same host is a no-op.
   */
  async start(host: StandaloneHost): Promise<void> {
    if (this.connection !== undefined) return;
    this.connection = await this.factory.connect({
      url: this.url,
      scope: this.scope,
      agentInfo: { name: this.agentName, role: "orchestrator" },
      capabilities: { swarm: true },
    });
    this.host = host;
    // Same EventEmitter access pattern peer-team.ts uses for `until_signal`.
    // The host has a private `events` EventEmitter that fans out lane events.
    const bus = (host as unknown as { readonly events: EventEmitter }).events;
    this.listener = (event: LaneEvent) => this.onLaneEvent(event);
    bus.on("lane_event", this.listener);
  }

  /**
   * Unsubscribe from the host bus and close the connection. Errors during
   * close are swallowed — the orchestrator should never fail a run because
   * the MAP server hung up.
   */
  async stop(): Promise<void> {
    if (this.host !== undefined && this.listener !== undefined) {
      const bus = (this.host as unknown as { readonly events: EventEmitter })
        .events;
      bus.off("lane_event", this.listener);
      this.host = undefined;
      this.listener = undefined;
    }
    if (this.connection !== undefined) {
      const conn = this.connection;
      this.connection = undefined;
      await conn.close().catch(() => {});
    }
  }

  private onLaneEvent(event: LaneEvent): void {
    if (this.connection === undefined) return;
    const mapped = this.translate(event);
    if (mapped === null) return;
    // Inject scope into every payload so the MAP server can route by team.
    const params = {
      ...(mapped.params as Record<string, unknown> | undefined),
      scope: this.scope,
    };
    this.connection.notify(mapped.method, params);
  }

  private translate(
    event: LaneEvent,
  ): { method: string; params: unknown } | null {
    switch (event.type) {
      case "worker_spawned":
        return { method: "swarm.agent.spawned", params: event.payload };
      case "worker_exited": {
        const payload = event.payload as
          | { exitCode?: number; error?: unknown }
          | undefined;
        const isSuccess =
          payload?.exitCode === 0 || payload?.exitCode === undefined;
        return {
          method: isSuccess ? "swarm.agent.completed" : "swarm.agent.failed",
          params: event.payload,
        };
      }
      case "task_created":
        return { method: "swarm.task.dispatched", params: event.payload };
      case "task_updated":
        return { method: "swarm.task.updated", params: event.payload };
      case "task_completed":
        return { method: "swarm.task.completed", params: event.payload };
      case "message_sent":
        return { method: "swarm.message.sent", params: event.payload };
      case "branch_lock_acquired":
        return { method: "swarm.branch.locked", params: event.payload };
      case "branch_lock_released":
        return { method: "swarm.branch.released", params: event.payload };
      case "team_started":
        return { method: "swarm.team.started", params: event.payload };
      case "team_completed":
        return { method: "swarm.team.completed", params: event.payload };
      case "team_aborted":
        return { method: "swarm.team.aborted", params: event.payload };
      default:
        // Unmapped events (turn_start, text_delta, tool_use_*, heartbeat, ...)
        // are intentionally silent — see header comment.
        return null;
    }
  }
}
