/**
 * NativeEngine snapshot helpers.
 *
 * The snapshot is the resume-optimized blob NativeEngine writes after each
 * turn boundary. The JSONL event log remains the authoritative record;
 * this file just lets `--resume` rebuild the message buffer without replay.
 *
 * See docs/archive/13-m4a-plan.md §5.3 / §5.4.
 */

import type { ProviderMessage } from "../providers/index.js";
import type { Usage } from "../core/types.js";
import type { SessionSnapshot } from "./index.js";

export interface NativeSnapshot {
  readonly messages: readonly ProviderMessage[];
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly cumulativeUsage: Usage;
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
): SessionSnapshot {
  const data: NativeSnapshot = {
    messages,
    turnCount,
    compactionCount,
    cumulativeUsage,
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
