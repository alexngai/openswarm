/**
 * HardenedNativeEngine snapshot helpers.
 *
 * Extends NativeSnapshot with retry statistics for observability.
 * Maps to Codex's `SamplingRequestResult` (turn.rs:1202-1206).
 */

import type { ProviderMessage } from "../providers/index.js";
import type { Usage } from "../core/types.js";
import type { SessionSnapshot } from "./index.js";

export interface HardenedNativeSnapshot {
  readonly messages: readonly ProviderMessage[];
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly cumulativeUsage: Usage;
  readonly retryStats: {
    readonly totalRetries: number;
    readonly retriesThisTurn: number;
  };
}

export function makeHardenedSnapshot(
  messages: readonly ProviderMessage[],
  turnCount: number,
  compactionCount: number,
  cumulativeUsage: Usage,
  retryStats: { totalRetries: number; retriesThisTurn: number },
): SessionSnapshot {
  const data: HardenedNativeSnapshot = {
    messages,
    turnCount,
    compactionCount,
    cumulativeUsage,
    retryStats,
  };
  return { engineId: "hardened-native", data };
}

export function isHardenedNativeSnapshot(snap: SessionSnapshot): boolean {
  return snap.engineId === "hardened-native";
}

export function extractHardenedNativeSnapshot(
  snap: SessionSnapshot,
): HardenedNativeSnapshot {
  if (!isHardenedNativeSnapshot(snap)) {
    throw new Error(
      `expected hardened-native snapshot; got ${snap.engineId}`,
    );
  }
  return snap.data as HardenedNativeSnapshot;
}
