/**
 * FileMemoryProvider — built-in provider wrapping Layer 1 (curated) + Layer 3 (archive).
 *
 * Always active, no external dependencies. Handles:
 * - enrichTurn: returns curated memory fragments
 * - onMemoryWrite: syncs to curated memory store
 * - onTurnComplete: no-op (archive happens at session end)
 * - onCompress: no-op (curated memory is already bounded)
 * - search: session-archive lookups (Phase 3 B2 — the durable fallback
 *   behind `memory_search` when minimem is unavailable)
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
import { installDefaultArchiveStore, searchArchive } from "../archive.js";
import { FileArchiveStore } from "./file-archive-store.js";

export class FileMemoryProvider implements MemoryProvider {
  readonly name = "file";
  readonly capabilities: MemoryCapabilities = {
    enrichment: true,
    persistence: true,
    search: true,
    graph: false,
  };

  async initialize(config: ProviderConfig): Promise<void> {
    // Phase 3 B2 — swap the volatile in-memory archive default for the
    // durable JSONL store (~/.openswarm/memory/session-archive.jsonl).
    // Never clobbers a store installed via setArchiveStore. Under vitest the
    // durable store is only installed when a path is passed explicitly, so
    // tests can't write into the developer's real home directory.
    const archiveFile =
      typeof config.archiveFile === "string" ? config.archiveFile : undefined;
    if (archiveFile !== undefined || process.env.VITEST === undefined) {
      installDefaultArchiveStore(new FileArchiveStore(archiveFile));
    }
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

  /** Session-archive search (Phase 3 B2). Uses the global archive store. */
  async search(
    query: string,
    opts?: { readonly limit?: number },
  ): Promise<MemoryFragment[]> {
    return searchArchive(query, opts?.limit ?? 5).map((r) => ({
      source: `file:archive:${r.sessionId}`,
      content: [
        r.summary,
        r.tags.length > 0 ? `Tags: ${r.tags.join(", ")}` : "",
        r.toolsUsed.length > 0 ? `Tools: ${r.toolsUsed.join(", ")}` : "",
        `Date: ${r.createdAt}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    }));
  }

  async onMemoryWrite(_entry: MemoryEntry): Promise<void> {
    // Curated memory writes go directly through executeCuratedAction;
    // session archives go through archiveSession at session end.
  }

  async onTurnComplete(_turn: CompletedTurn): Promise<void> {
    // Archive happens at session end, not per-turn
  }

  async onCompress(_summary: CompressionSummary): Promise<void> {
    // Curated memory is already bounded and doesn't need compression handling
  }
}
