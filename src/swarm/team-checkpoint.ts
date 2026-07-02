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
import * as path from "node:path";
import type { TeamSpec, TopologyKind } from "./team-spec.js";

export const TEAM_CHECKPOINT_SCHEMA_VERSION = 1;

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

/** On-disk checkpoint document. */
export interface TeamCheckpointData {
  readonly schemaVersion: number;
  readonly teamName: string;
  readonly topology: TopologyKind;
  readonly specHash: string;
  readonly units: readonly CompletedUnit[];
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
  /** True if `unitId` previously reached `succeeded` (auto-resume skips it). */
  isDone(unitId: string): boolean;
  /** Look up a prior unit — used to reuse a succeeded unit's output. */
  get(unitId: string): CompletedUnit | undefined;
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

  return {
    schemaVersion: TEAM_CHECKPOINT_SCHEMA_VERSION,
    teamName: expected.teamName,
    topology: expected.topology,
    specHash: expected.specHash,
    units,
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
    const raw = await fsp.readFile(checkpointPath, "utf8");
    prior = parseCheckpoint(raw, expected);
  } catch {
    prior = null;
  }

  // Index by id. On duplicate ids the latest record wins (record() dedups too).
  const byId = new Map<string, CompletedUnit>();
  if (prior !== null) {
    for (const u of prior.units) byId.set(u.id, u);
  }
  const resumed = prior !== null && byId.size > 0;
  const resumedUnitCount = resumed
    ? [...byId.values()].filter((u) => u.status === "succeeded").length
    : 0;

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
      updatedAt: Date.now(),
    };
    await fsp.mkdir(path.dirname(checkpointPath), { recursive: true });
    const tmp = `${checkpointPath}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(data) + "\n");
    await fsp.rename(tmp, checkpointPath);
  };

  return {
    resumed,
    resumedUnitCount,
    isDone(unitId: string): boolean {
      return byId.get(unitId)?.status === "succeeded";
    },
    get(unitId: string): CompletedUnit | undefined {
      return byId.get(unitId);
    },
    record(unit: CompletedUnit): Promise<void> {
      byId.set(unit.id, unit);
      writeChain = writeChain.then(() => (closed ? Promise.resolve() : persist()));
      return writeChain;
    },
    async close(): Promise<void> {
      await writeChain;
      closed = true;
    },
  };
}
