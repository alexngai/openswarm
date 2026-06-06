/**
 * MinimemProvider — optional provider wrapping the minimem package for
 * hybrid vector + BM25 search and knowledge graph capabilities.
 *
 * minimem is an optional dependency. If not installed or if embedding setup
 * fails, the provider degrades gracefully:
 * 1. With embeddings: full hybrid vector + BM25 search
 * 2. Without embeddings: BM25-only search (still useful)
 * 3. Without minimem: provider reports unavailable, coordinator skips it
 */

import * as path from "node:path";
import * as fs from "node:fs";
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

// ---------------------------------------------------------------------------
// Dynamic import wrapper — minimem is optional
// ---------------------------------------------------------------------------

interface MinimemInstance {
  search(query: string, opts?: { maxResults?: number; minScore?: number }): Promise<Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
  }>>;
  writeFile(relativePath: string, content: string): Promise<void>;
  appendToday(content: string): Promise<string>;
  sync(opts?: { reason?: string; force?: boolean }): Promise<void>;
  status(): Promise<{
    provider: string;
    model: string;
    vectorAvailable: boolean;
    ftsAvailable: boolean;
    bm25Only: boolean;
    fallbackReason?: string;
    fileCount: number;
    chunkCount: number;
  }>;
  close(): void;
}

interface MinimemModule {
  Minimem: {
    create(config: Record<string, unknown>): Promise<MinimemInstance>;
  };
}

async function tryLoadMinimem(): Promise<MinimemModule | null> {
  try {
    return await import("minimem") as unknown as MinimemModule;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface MinimemProviderConfig {
  memoryDir?: string;
  embeddingProvider?: "openai" | "local" | "gemini" | "auto" | "none";
  embeddingModel?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  maxResults?: number;
  minScore?: number;
}

export class MinimemProvider implements MemoryProvider {
  readonly name = "minimem";
  readonly capabilities: MemoryCapabilities = {
    enrichment: true,
    persistence: true,
    search: true,
    graph: true,
  };

  private instance: MinimemInstance | null = null;
  private config: MinimemProviderConfig = {};

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config as MinimemProviderConfig;

    const mod = await tryLoadMinimem();
    if (!mod) return;

    const memoryDir =
      this.config.memoryDir ??
      process.env.MINIMEM_STORE_PATH ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".swarm-harness",
        "memory",
      );

    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const envProvider = process.env.MINIMEM_EMBEDDING_PROVIDER;
    const validProviders = new Set(["openai", "local", "gemini", "auto", "none"]);
    const embeddingProvider =
      this.config.embeddingProvider ??
      (envProvider && validProviders.has(envProvider) ? envProvider as MinimemProviderConfig["embeddingProvider"] : undefined) ??
      "none";

    try {
      this.instance = await mod.Minimem.create({
        memoryDir,
        embedding: {
          provider: embeddingProvider,
          ...(this.config.embeddingModel && { model: this.config.embeddingModel }),
          ...(embeddingProvider === "openai" && {
            openai: {
              apiKey: this.config.openaiApiKey ?? process.env.OPENAI_API_KEY,
              ...(this.config.openaiBaseUrl && { baseUrl: this.config.openaiBaseUrl }),
            },
          }),
        },
        watch: { enabled: false },
      });
    } catch {
      this.instance = null;
    }
  }

  async shutdown(): Promise<void> {
    if (this.instance) {
      this.instance.close();
      this.instance = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.instance !== null;
  }

  async enrichTurn(context: TurnContext): Promise<MemoryFragment[]> {
    if (!this.instance || !context.query) return [];

    const maxResults = this.config.maxResults ?? 5;
    const minScore = this.config.minScore ?? 0.3;

    try {
      const results = await this.instance.search(context.query, {
        maxResults,
        minScore,
      });

      return results.map((r) => ({
        source: `minimem:${r.path}`,
        content: r.snippet,
        relevance: r.score,
      }));
    } catch {
      return [];
    }
  }

  async onMemoryWrite(entry: MemoryEntry): Promise<void> {
    if (!this.instance) return;

    try {
      await this.instance.appendToday(
        `## ${entry.scope} memory\n${entry.content}\n`,
      );
    } catch {
      // best-effort
    }
  }

  async onTurnComplete(turn: CompletedTurn): Promise<void> {
    if (!this.instance) return;

    if (turn.summary) {
      try {
        await this.instance.appendToday(
          `## Turn ${turn.turnIndex} summary\n${turn.summary}\n` +
            (turn.toolsUsed.length > 0
              ? `Tools: ${turn.toolsUsed.join(", ")}\n`
              : ""),
        );
      } catch {
        // best-effort
      }
    }
  }

  async onCompress(summary: CompressionSummary): Promise<void> {
    if (!this.instance) return;

    try {
      await this.instance.appendToday(
        `## Compaction (${summary.messageCount} messages)\n${summary.summary}\n`,
      );
    } catch {
      // best-effort
    }
  }
}
