/**
 * NativeEngine snapshot helpers.
 *
 * The snapshot is the resume-optimized blob NativeEngine writes after each
 * turn boundary. The JSONL event log remains the authoritative record;
 * this file just lets `--resume` rebuild the message buffer without replay.
 */

import type { ProviderMessage } from "../providers/index.js";
import type { Usage } from "../core/types.js";
import type { SessionSnapshot } from "./index.js";
import type { PersistedCompactionState } from "./compaction-runner.js";

export interface NativeSnapshot {
  readonly messages: readonly ProviderMessage[];
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly cumulativeUsage: Usage;
  /** Compaction trigger/breaker state. Absent in pre-migration snapshots. */
  readonly compaction?: PersistedCompactionState;
}

/**
 * Wrap a NativeSnapshot into a SessionSnapshot envelope with
 * `engineId: "native"` so the outer resume path knows which engine owns it.
 */
export function makeSnapshot(
  messages: readonly ProviderMessage[],
  turnCount: number,
  compactionCount: number,
  cumulativeUsage: Usage,
  compaction?: PersistedCompactionState,
): SessionSnapshot {
  const data: NativeSnapshot = {
    messages,
    turnCount,
    compactionCount,
    cumulativeUsage,
    ...(compaction !== undefined ? { compaction } : {}),
  };
  return { engineId: "native", data };
}

export function isNativeSnapshot(snap: SessionSnapshot): boolean {
  return snap.engineId === "native";
}

export function extractNativeSnapshot(snap: SessionSnapshot): NativeSnapshot {
  if (!isNativeSnapshot(snap)) {
    throw new Error(
      `expected native snapshot; got ${snap.engineId}`,
    );
  }
  return snap.data as NativeSnapshot;
}
