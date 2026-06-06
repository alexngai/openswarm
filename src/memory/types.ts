/**
 * Memory system types — shared across all layers and providers.
 */

import type { AgentId } from "../core/types.js";

// ---------------------------------------------------------------------------
// Curated memory (Layer 1)
// ---------------------------------------------------------------------------

export type CuratedScope = "project" | "user";

export interface CuratedMemoryRecord {
  readonly scopeKey: string;
  readonly content: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Memory provider protocol (Layer 4)
// ---------------------------------------------------------------------------

export interface MemoryCapabilities {
  readonly enrichment: boolean;
  readonly persistence: boolean;
  readonly search: boolean;
  readonly graph: boolean;
}

export interface ProviderConfig {
  readonly [key: string]: unknown;
}

export interface MemoryFragment {
  readonly source: string;
  readonly content: string;
  readonly relevance?: number;
}

export interface TurnContext {
  readonly query?: string;
  readonly agentId?: AgentId;
  readonly sessionId?: string;
  readonly turnCount?: number;
  readonly projectRoot?: string;
  readonly userId?: string;
}

export interface MemoryEntry {
  readonly scope: CuratedScope;
  readonly content: string;
  readonly agentId?: AgentId;
  readonly timestamp: string;
}

export interface CompletedTurn {
  readonly sessionId: string;
  readonly agentId?: AgentId;
  readonly turnIndex: number;
  readonly toolsUsed: readonly string[];
  readonly summary?: string;
}

export interface CompressionSummary {
  readonly sessionId: string;
  readonly messageCount: number;
  readonly summary: string;
}

export interface MemoryProvider {
  readonly name: string;
  readonly capabilities: MemoryCapabilities;

  initialize(config: ProviderConfig): Promise<void>;
  shutdown(): Promise<void>;
  isAvailable(): Promise<boolean>;

  enrichTurn(context: TurnContext): Promise<MemoryFragment[]>;
  onMemoryWrite(entry: MemoryEntry): Promise<void>;
  onTurnComplete(turn: CompletedTurn): Promise<void>;
  onCompress(summary: CompressionSummary): Promise<void>;
}
