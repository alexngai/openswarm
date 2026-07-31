/**
 * team-checkpoint.ts — durable per-team progress checkpoint (crash-recovery T1).
 *
 * A detached team daemon that crashes/restarts otherwise re-runs its whole
 * topology from scratch (see TeamDaemon.start → runTeam(spec)). This module
 * adds a small, generic, topology-agnostic progress record so a restart can
 * skip work that already completed successfully and only re-dispatch the rest.
 *
 * Design (docs/28 — team crash-recovery T1):
 *   - The unit of recovery is a "completed unit" keyed by a stable id that each
 *     topology already assigns to its work items (fanout task id, pipeline
 *     stage id, …). The store is intentionally ignorant of topology internals;
 *     topologies opt in by calling `isDone`/`get`/`record` on the store handed
 *     to them via TopologyContext.checkpoint. A topology that never calls the
 *     store is simply not resumable yet — adoption is incremental.
 *   - Auto-resume semantics: `isDone` is true ONLY for units that previously
 *     reached `succeeded`. Failed / timeout / cancelled units are re-run on
 *     restart (they never completed). This is the "skip proven-good work only"
 *     contract the daemon relies on.
 *   - Spec-hash guard: the checkpoint records a hash of the spec's recovery-
 *     relevant shape. On open, a checkpoint whose hash doesn't match the
 *     current spec is discarded (a fresh run starts). This prevents auto-resume
 *     from stitching a new/edited team onto stale progress.
 *   - Persistence is a whole-file atomic write (temp + rename) on every
 *     `record`. Unit completions are infrequent (seconds–minutes apart) so the
 *     rewrite cost is negligible; atomicity guarantees a crash mid-write can't
 *     corrupt the checkpoint. Concurrent `record` calls (fanout runs tasks in
 *     parallel) are serialized through an internal write chain.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { readSnapshot, writeSnapshot } from "./atomic-snapshot.js";
import * as path from "node:path";
import type { TeamSpec, TopologyKind } from "./team-spec.js";

// v2 (crash-recovery T2): adds `inFlight` — units that were dispatched but had
// not reached a terminal state when the daemon crashed. A v1 checkpoint (no
// inFlight) is treated as unreadable and a fresh run starts; there is no
// production checkpoint data to migrate.
export const TEAM_CHECKPOINT_SCHEMA_VERSION = 2;

/** Terminal outcome of a single recovery unit, mirrored from ResultLine. */
export type UnitStatus = "succeeded" | "failed" | "timeout" | "cancelled";

/**
 * One completed unit of team work. `output` is captured for succeeded units so
 * a resuming topology can reuse it (e.g. pipeline threads the previous stage's
 * output into the next stage's prompt without re-running the stage).
 */
export interface CompletedUnit {
  readonly id: string;
  readonly status: UnitStatus;
  readonly output?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly completedAt: number;
}

/**
 * A unit that has been dispatched to a worker but has not yet reached a
 * terminal state (crash-recovery T2). Recorded at dispatch time so a restart
 * can tell "never started" (run fresh) apart from "was mid-flight when we
 * crashed" (re-dispatch with a verify-then-continue preamble, resuming the
 * worker's engine session from its per-unit sidecar).
 */
export interface InFlightUnit {
  readonly id: string;
  /** Per-unit session sidecar the worker (re)writes its engine session id to. */
  readonly sidecarPath?: string;
  readonly agentId?: string;
  readonly dispatchedAt: number;
}

/** On-disk checkpoint document. */
export interface TeamCheckpointData {
  readonly schemaVersion: number;
  readonly teamName: string;
  readonly topology: TopologyKind;
  readonly specHash: string;
  readonly units: readonly CompletedUnit[];
  readonly inFlight: readonly InFlightUnit[];
  readonly updatedAt: number;
}

/**
 * The generic restorable interface every topology sees. Injected via
 * TopologyContext.checkpoint (optional — absent means "no recovery").
 */
export interface TeamCheckpointStore {
  /** True when a valid prior checkpoint was loaded (this run is a resume). */
  readonly resumed: boolean;
  /** Number of already-succeeded units carried over from a prior run. */
  readonly resumedUnitCount: number;
  /**
   * Number of units that were mid-flight in the prior (crashed) run and will
   * be re-dispatched this run (crash-recovery T2).
   */
  readonly resumedInFlightCount: number;
  /** True if `unitId` previously reached `succeeded` (auto-resume skips it). */
  isDone(unitId: string): boolean;
  /** Look up a prior unit — used to reuse a succeeded unit's output. */
  get(unitId: string): CompletedUnit | undefined;
  /**
   * If `unitId` was dispatched-but-not-succeeded in the prior (crashed) run,
   * returns its prior in-flight record (crash-recovery T2). The topology uses
   * this to re-dispatch with a verify-then-continue preamble and to resume the
   * worker's engine session from the same per-unit sidecar. Returns undefined
   * for units that never started or that already succeeded. Reflects the
   * prior run's snapshot and is stable for the lifetime of this run.
   */
  wasInFlight(unitId: string): InFlightUnit | undefined;
  /**
   * Deterministic per-unit session sidecar path (stable across restarts) so a
   * re-dispatched worker resumes the same engine session. Lives under a
   * `sessions/` dir next to the checkpoint file.
   */
  sidecarPathFor(unitId: string): string;
  /** Record that a unit has been dispatched (in-flight) and persist. */
  markDispatched(unit: InFlightUnit): Promise<void>;
  /** Record a terminal unit outcome and persist atomically. */
  record(unit: CompletedUnit): Promise<void>;
  /** Flush pending writes and release resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Deterministic hash of a spec's recovery-relevant shape. Two specs that
 * differ only in fields irrelevant to recovery (e.g. transient runtime cwd)
 * hash equal; changing topology, member order, ids, roles, prompts, models, or
 * the completion rule invalidates a prior checkpoint.
 */
export function computeSpecHash(spec: TeamSpec): string {
  const canonical = {
    topology: spec.topology,
    completion: spec.coordination.completion,
    members: spec.members.map((m, idx) => ({
      id: m.id ?? `#${idx}`,
      role: m.role,
      prompt: m.prompt,
      model: m.model ?? null,
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Parse + validate a checkpoint document. Returns null when the payload is
 * malformed, the schema version is unknown, or the spec hash doesn't match —
 * all of which mean "treat as no checkpoint and start fresh".
 */
/**
 * Read a checkpoint file, accepting both the checksummed envelope written today
 * and the bare document written before `WP-07`.
 *
 * The legacy fallback is not politeness: a team upgraded mid-run has a checkpoint
 * on disk in the old shape, and refusing it would silently re-run every unit that
 * had already succeeded. It is the narrow case of what `WP-07`'s importer has to
 * do generally — accept what is there, and be explicit about what it could not
 * verify.
 *
 * A checkpoint that fails verification is treated as absent, which for this
 * artefact is the safe direction: the team redoes work rather than skipping work
 * it never did.
 */
export async function loadCheckpoint(
  checkpointPath: string,
  expected: { teamName: string; topology: TopologyKind; specHash: string },
): Promise<TeamCheckpointData | null> {
  const read = await readSnapshot<unknown>(checkpointPath);
  if (read.kind === "ok") {
    return parseCheckpoint(JSON.stringify(read.data), expected);
  }
  if (read.kind === "absent") return null;
  if (read.reason !== "not a checksummed snapshot") return null;

  // Pre-WP-07 checkpoint: a bare document, unverified by construction.
  try {
    return parseCheckpoint(await fsp.readFile(checkpointPath, "utf8"), expected);
  } catch {
    return null;
  }
}

export function parseCheckpoint(
  raw: string,
  expected: { teamName: string; topology: TopologyKind; specHash: string },
): TeamCheckpointData | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const d = obj as Record<string, unknown>;
  if (d.schemaVersion !== TEAM_CHECKPOINT_SCHEMA_VERSION) return null;
  if (d.teamName !== expected.teamName) return null;
  if (d.topology !== expected.topology) return null;
  if (d.specHash !== expected.specHash) return null;
  if (!Array.isArray(d.units)) return null;

  const units: CompletedUnit[] = [];
  for (const u of d.units) {
    if (typeof u !== "object" || u === null) continue;
    const r = u as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    if (
      r.status !== "succeeded" &&
      r.status !== "failed" &&
      r.status !== "timeout" &&
      r.status !== "cancelled"
    ) {
      continue;
    }
    units.push({
      id: r.id,
      status: r.status,
      completedAt: typeof r.completedAt === "number" ? r.completedAt : 0,
      ...(typeof r.output === "string" && { output: r.output }),
      ...(typeof r.agentId === "string" && { agentId: r.agentId }),
      ...(typeof r.sessionId === "string" && { sessionId: r.sessionId }),
    });
  }

  // inFlight is optional-tolerant: a missing/malformed array just means "no
  // units were mid-flight" so a fresh dispatch happens for everything not done.
  const inFlight: InFlightUnit[] = [];
  if (Array.isArray(d.inFlight)) {
    for (const u of d.inFlight) {
      if (typeof u !== "object" || u === null) continue;
      const r = u as Record<string, unknown>;
      if (typeof r.id !== "string") continue;
      inFlight.push({
        id: r.id,
        dispatchedAt: typeof r.dispatchedAt === "number" ? r.dispatchedAt : 0,
        ...(typeof r.sidecarPath === "string" && { sidecarPath: r.sidecarPath }),
        ...(typeof r.agentId === "string" && { agentId: r.agentId }),
      });
    }
  }

  return {
    schemaVersion: TEAM_CHECKPOINT_SCHEMA_VERSION,
    teamName: expected.teamName,
    topology: expected.topology,
    specHash: expected.specHash,
    units,
    inFlight,
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
  };
}

/**
 * Open (or create) a team checkpoint store at `checkpointPath` for `spec`.
 *
 * When a valid, matching checkpoint already exists on disk it is loaded and
 * `resumed` is true. When absent / malformed / spec-mismatched, a fresh store
 * is returned (`resumed` false) and the stale file, if any, is left to be
 * overwritten on the first `record`.
 */
export async function openTeamCheckpoint(opts: {
  readonly checkpointPath: string;
  readonly spec: TeamSpec;
}): Promise<TeamCheckpointStore> {
  const { checkpointPath, spec } = opts;
  const specHash = computeSpecHash(spec);
  const expected = { teamName: spec.name, topology: spec.topology, specHash };

  let prior: TeamCheckpointData | null = null;
  try {
    prior = await loadCheckpoint(checkpointPath, expected);
  } catch {
    prior = null;
  }

  // Index by id. On duplicate ids the latest record wins (record() dedups too).
  const byId = new Map<string, CompletedUnit>();
  if (prior !== null) {
    for (const u of prior.units) byId.set(u.id, u);
  }

  // Prior-run in-flight snapshot (T2): units dispatched but not succeeded when
  // the daemon crashed. Frozen at open so wasInFlight() is stable this run even
  // as we markDispatched() the same ids again below. A prior unit that also has
  // a succeeded terminal record is NOT a resume candidate (it finished).
  const priorInFlight = new Map<string, InFlightUnit>();
  if (prior !== null) {
    for (const u of prior.inFlight) {
      if (byId.get(u.id)?.status === "succeeded") continue;
      priorInFlight.set(u.id, u);
    }
  }

  // Live in-flight set for THIS run (persisted so a crash this run is also
  // recoverable). markDispatched adds; record (terminal) removes.
  const inFlightById = new Map<string, InFlightUnit>();

  const resumedUnitCount = [...byId.values()].filter(
    (u) => u.status === "succeeded",
  ).length;
  const resumedInFlightCount = priorInFlight.size;
  const resumed =
    prior !== null && (resumedUnitCount > 0 || resumedInFlightCount > 0);

  const sessionsDir = path.join(path.dirname(checkpointPath), "sessions");
  const sidecarPathFor = (unitId: string): string =>
    path.join(sessionsDir, `${unitId.replace(/[^a-zA-Z0-9._-]/g, "_")}.session`);

  // Serialize atomic writes so parallel record() calls (fanout) don't race.
  let writeChain: Promise<void> = Promise.resolve();
  let closed = false;

  const persist = async (): Promise<void> => {
    const data: TeamCheckpointData = {
      schemaVersion: TEAM_CHECKPOINT_SCHEMA_VERSION,
      teamName: spec.name,
      topology: spec.topology,
      specHash,
      units: [...byId.values()],
      inFlight: [...inFlightById.values()],
      updatedAt: Date.now(),
    };
    // Checksummed, fsync'd, then renamed. The rename alone was atomic against a
    // reader but said nothing about the bytes reaching disk first, and nothing
    // about integrity: a checkpoint damaged by anything other than an
    // interrupted write reads back as plausible resume state (docs/63 WP-07).
    await writeSnapshot(checkpointPath, data);
  };

  const enqueue = (): Promise<void> => {
    writeChain = writeChain.then(() =>
      closed ? Promise.resolve() : persist(),
    );
    return writeChain;
  };

  return {
    resumed,
    resumedUnitCount,
    resumedInFlightCount,
    isDone(unitId: string): boolean {
      return byId.get(unitId)?.status === "succeeded";
    },
    get(unitId: string): CompletedUnit | undefined {
      return byId.get(unitId);
    },
    wasInFlight(unitId: string): InFlightUnit | undefined {
      return priorInFlight.get(unitId);
    },
    sidecarPathFor,
    markDispatched(unit: InFlightUnit): Promise<void> {
      // Already terminal (e.g. a race)? Nothing to mark.
      if (byId.get(unit.id)?.status === "succeeded") return Promise.resolve();
      inFlightById.set(unit.id, unit);
      return enqueue();
    },
    record(unit: CompletedUnit): Promise<void> {
      byId.set(unit.id, unit);
      // Terminal now — it's no longer in flight.
      inFlightById.delete(unit.id);
      return enqueue();
    },
    async close(): Promise<void> {
      await writeChain;
      closed = true;
    },
  };
}
