/**
 * Memory system — 4-layer architecture with pluggable providers.
 *
 * See docs/40-memory-system-design.md for the full design.
 */

export type {
  CuratedScope,
  CuratedMemoryRecord,
  MemoryCapabilities,
  ProviderConfig,
  MemoryFragment,
  TurnContext,
  MemoryEntry,
  CompletedTurn,
  CompressionSummary,
  MemoryProvider,
} from "./types.js";

export {
  getCuratedMemoryStore,
  setCuratedMemoryStore,
  resetCuratedMemoryStore,
  getCuratedMemoryLimits,
  setCuratedMemoryLimits,
  resetCuratedMemoryLimits,
  scopeKey,
  parseEntries,
  formatEntries,
  executeCuratedAction,
  getCuratedMemory,
  type CuratedMemoryStore,
  type CuratedMemoryLimits,
  type CuratedMemoryAction,
  type CuratedMemoryResult,
} from "./curated.js";

export {
  MemoryCoordinator,
  getMemoryCoordinator,
  setMemoryCoordinator,
  resetMemoryCoordinator,
} from "./coordinator.js";

export { curatedMemoryFragment } from "./fragment.js";

export { StateDBCuratedStore } from "./state-store.js";
