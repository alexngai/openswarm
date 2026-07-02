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

export {
  getArchiveStore,
  setArchiveStore,
  resetArchiveStore,
  archiveSession,
  searchArchive,
  listArchive,
  type ArchiveStore,
  type ArchiveSessionInput,
  type ArchiveSearchResult,
} from "./archive.js";

export { StateDBCuratedStore, StateDBArchiveStore } from "./state-store.js";

export {
  agentScopeKey,
  publishSharedMemory,
  getSharedMemory,
  resetSharedMemory,
  formatSharedMemory,
  type SharedMemoryEntry,
} from "./agent-scope.js";

export { FileMemoryProvider } from "./providers/file-provider.js";
export { MinimemProvider, type MinimemProviderConfig } from "./providers/minimem-provider.js";
export { SkillProvider, resolveSkillsDir, type SkillProviderConfig } from "./providers/skill-provider.js";

export {
  onSessionStart,
  onBeforeTurn,
  onAfterTurn,
  onCompaction,
  onSessionEnd,
  formatMemoryFragments,
  enrichTurnInputs,
  type SessionStartOptions,
  type TurnCompleteInfo,
  type SessionEndInfo,
} from "./lifecycle.js";

export {
  maybeAutoConsolidate,
  evaluateConsolidationCadence,
  resolveCadenceOptions,
  resolveCommand,
  resolveOnPath,
  stateFilePath,
  readState,
  writeState,
  resetSpawnClock,
  type ConsolidateState,
  type CadenceOptions,
  type CadenceDecision,
  type MaybeConsolidateOptions,
  type MaybeConsolidateResult,
} from "./auto-consolidate.js";
