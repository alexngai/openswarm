/**
 * TeamRunner — the team-side analog of Stage A's AgentEngine: run a team and
 * subscribe to its LaneEvent stream. AcpTeamAgent depends on this interface so
 * it can be unit-tested with a fake; `createOrchestratorRunner` wires the real
 * Orchestrator.
 *
 * The real adapter mirrors the team-daemon's proven wiring
 * (src/swarm/team-daemon.ts:262-294): own a StandaloneHost, hand it to a
 * persistent Orchestrator, and subscribe to the host's lane-event bus via the
 * established duck-typed `events` access (also used by adapters/map-adapter.ts).
 */

import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Orchestrator } from "../swarm/orchestrator.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import type { TeamSpec } from "../swarm/team-spec.js";
import type { TeamResult } from "../swarm/topologies-types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { TeamSession } from "../swarm/team-session.js";
import type { PermissionMode } from "../core/types.js";

export interface TeamRunner {
  runTeam(spec: TeamSpec): Promise<TeamResult>;
  /** Subscribe to the team's lane-event stream; returns an unsubscribe fn. */
  subscribeEvents(handler: (event: LaneEvent) => void): () => void;
  /** The live TeamSession (persistent mode) for steering; undefined until a run. */
  getActiveTeam(): TeamSession | undefined;
}

/** Discards the orchestrator's results-JSONL sink — ACP surfaces output via lane events. */
class NullWritable extends Writable {
  override _write(
    _chunk: unknown,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    cb();
  }
}

export interface OrchestratorRunnerOptions {
  readonly permissionMode: PermissionMode;
  readonly concurrency?: number;
}

export function createOrchestratorRunner(
  opts: OrchestratorRunnerOptions,
): TeamRunner {
  const host = new StandaloneHost({ permissionMode: opts.permissionMode });
  const orch = new Orchestrator({
    concurrency: opts.concurrency ?? 4,
    permissionMode: opts.permissionMode,
    resultsOut: new NullWritable(),
    host,
    persistent: true,
  });
  const bus = (host as unknown as { readonly events: EventEmitter }).events;
  return {
    runTeam: (spec) => orch.runTeam(spec),
    subscribeEvents: (handler) => {
      bus.on("lane_event", handler);
      return () => {
        bus.off("lane_event", handler);
      };
    },
    getActiveTeam: () => orch.getActiveTeam(),
  };
}
