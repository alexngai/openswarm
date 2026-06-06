/**
 * FileMemoryProvider — built-in provider wrapping Layer 1 (curated) + Layer 3 (archive).
 *
 * Always active, no external dependencies. Handles:
 * - enrichTurn: returns curated memory fragments
 * - onMemoryWrite: syncs to curated memory store
 * - onTurnComplete: no-op (archive happens at session end)
 * - onCompress: no-op (curated memory is already bounded)
 */

import type {
  MemoryProvider,
  MemoryCapabilities,
  ProviderConfig,
  MemoryFragment,
  TurnContext,
  MemoryEntry,
  CompletedTurn,
  CompressionSummary,
} from "../types.js";
import { getCuratedMemory, scopeKey } from "../curated.js";

export class FileMemoryProvider implements MemoryProvider {
  readonly name = "file";
  readonly capabilities: MemoryCapabilities = {
    enrichment: true,
    persistence: true,
    search: false,
    graph: false,
  };

  async initialize(_config: ProviderConfig): Promise<void> {
    // No initialization needed — curated memory store is ready at import time
  }

  async shutdown(): Promise<void> {
    // No cleanup needed
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async enrichTurn(context: TurnContext): Promise<MemoryFragment[]> {
    const fragments: MemoryFragment[] = [];

    if (context.userId) {
      const userMemory = getCuratedMemory(scopeKey("user", context.userId));
      if (userMemory) {
        fragments.push({
          source: "file:user",
          content: userMemory,
          relevance: 1.0,
        });
      }
    }

    if (context.projectRoot) {
      const projectMemory = getCuratedMemory(
        scopeKey("project", context.projectRoot),
      );
      if (projectMemory) {
        fragments.push({
          source: "file:project",
          content: projectMemory,
          relevance: 1.0,
        });
      }
    }

    return fragments;
  }

  async onMemoryWrite(_entry: MemoryEntry): Promise<void> {
    // Curated memory writes go directly through executeCuratedAction,
    // so no additional sync is needed here.
  }

  async onTurnComplete(_turn: CompletedTurn): Promise<void> {
    // Archive happens at session end, not per-turn
  }

  async onCompress(_summary: CompressionSummary): Promise<void> {
    // Curated memory is already bounded and doesn't need compression handling
  }
}
