/**
 * topologies-types.ts — contract every topology implementation must satisfy.
 *
 * Stage 4C extracts the existing fanout coordination logic from Orchestrator
 * into a `FanoutTopology` class. This file declares the `Topology` interface,
 * the `TopologyContext` infrastructure handed to every run, and the
 * `TeamResult` aggregate counts that all topologies return.
 *
 * Stage 4E will introduce additional topology implementations (pipeline,
 * coordinator, peer-team, committee, critic-loop). Each will satisfy this
 * same `Topology` contract.
 */

import type { Writable } from "node:stream";
import type { StandaloneHost } from "./standalone-host.js";
import type { WorkerPool } from "./worker-pool.js";
import type { DeadLetterWriter } from "./dead-letter.js";
import type { TeamSpec, TopologyKind } from "./team-spec.js";
import type { RoleRegistry } from "./roles.js";
import type { TeamSession } from "./team-session.js";

/**
 * Topology — a coordination shape for a team.
 *
 * Each implementation owns the spawn/wait/retry/dead-letter logic
 * specific to its shape. They share infrastructure via TopologyContext.
 */
export interface Topology {
  readonly name: TopologyKind;
  run(spec: TeamSpec, ctx: TopologyContext): Promise<TeamResult>;
}

/**
 * TopologyContext — infrastructure handed to every topology run.
 */
export interface TopologyContext {
  readonly host: StandaloneHost;
  readonly pool: WorkerPool;
  readonly resultsOut: Writable;
  readonly deadLetter: DeadLetterWriter;
  readonly eventsOut?: Writable;
  /**
   * Role registry for resolving member.role to system-prompt + allowedTools.
   * Optional — falls through to spec.role string when absent.
   */
  readonly roles?: RoleRegistry;
  /** When true, dead-letter delta does NOT cause non-zero exit. */
  readonly allowDeadLetter?: boolean;
  /** Default role applied to members without their own role override. */
  readonly defaultRole?: string;
  /**
   * Process-wide cancellation signal. Set by Orchestrator when SIGINT fires.
   * Topologies treat `aborted === true` as "fail-cancel any pending work".
   */
  readonly abort?: AbortSignal;
  /** Permission mode forwarded to worker spawns. */
  readonly permissionMode: import("../core/types.js").PermissionMode;
  /**
   * v0.6 stage 5F: when true, the topology must NOT call `team.dispose()`
   * after its initial run completes. Members stay alive so subsequent
   * `team send` RPCs can spawn ad-hoc tasks into the same TeamSession.
   * Currently honored by PeerTeamTopology only; other topologies dispose
   * regardless until a real persistent-mode use case surfaces for them.
   */
  readonly persistent?: boolean;
  /**
   * v0.6 stage 5F: optional callback fired after the topology constructs
   * its TeamSession. The Orchestrator captures the reference so external
   * callers (e.g. the team daemon) can route `send_prompt` RPCs through
   * the live session.
   */
  readonly onTeamCreated?: (team: TeamSession) => void;
  /**
   * docs/44 P0 — landing-strategy registry for finalizing member streams.
   * Optional; topologies fall back to a built-in default registry
   * (`createDefaultLandingRegistry`) when absent, so existing callers need
   * no change.
   */
  readonly landingRegistry?: import("./landing/index.js").LandingRegistry;
  /**
   * docs/44 P0 — conflict-recovery registry. Created here for injection/
   * testing; dormant until P1 wires recovery dispatch into the landing path.
   */
  readonly recoveryRegistry?: import("./recovery/registry.js").RecoveryRegistry;
}

/**
 * TeamResult — outcome of a topology run. Counts mirror today's RunResult
 * for backward compat, plus aggregate fields for richer topologies.
 */
export interface TeamResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly timeout: number;
  readonly cancelled: number;
  readonly resultWriteFailures: number;
  /**
   * True when tasks were written to dead-letter AND allowDeadLetter is false,
   * OR when the dead-letter writer recorded any write failures (M2 guard).
   */
  readonly deadLetterViolation: boolean;
  /**
   * How many times the dead-letter writer failed to persist a line. Surfaced
   * so the CLI can differentiate "tasks dropped" from "drop file is broken"
   * in its exit message.
   */
  readonly deadLetterWriteFailures: number;
  /**
   * Stage 4E will add this for committee/judge topologies; today it's optional.
   */
  readonly aggregateOutput?: string;
}
