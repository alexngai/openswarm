/**
 * MemoryCoordinator — manages provider lifecycle and fans out hooks.
 *
 * Multiple providers can run simultaneously. enrichTurn results are merged;
 * write/complete/compress hooks are fire-and-forget with error capture.
 */

import type {
  MemoryProvider,
  MemoryFragment,
  TurnContext,
  MemoryEntry,
  CompletedTurn,
  CompressionSummary,
  ProviderConfig,
} from "./types.js";

const MAX_ENRICHMENT_FRAGMENTS = 50;

export class MemoryCoordinator {
  private providers: MemoryProvider[] = [];

  async register(provider: MemoryProvider, config?: ProviderConfig): Promise<void> {
    if (this.providers.some((p) => p.name === provider.name)) {
      throw new Error(`memory provider "${provider.name}" is already registered`);
    }
    await provider.initialize(config ?? {});
    this.providers.push(provider);
  }

  async unregister(name: string): Promise<void> {
    const idx = this.providers.findIndex((p) => p.name === name);
    if (idx === -1) return;
    const provider = this.providers[idx]!;
    this.providers.splice(idx, 1);
    try {
      await provider.shutdown();
    } catch (err) {
      console.warn(`memory provider "${name}" shutdown failed:`, err);
    }
  }

  get providerNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  get providerCount(): number {
    return this.providers.length;
  }

  async enrichTurn(context: TurnContext): Promise<MemoryFragment[]> {
    if (this.providers.length === 0) return [];

    const results = await Promise.allSettled(
      this.providers
        .filter((p) => p.capabilities.enrichment)
        .map((p) => p.enrichTurn(context)),
    );

    const fragments: MemoryFragment[] = [];
    const seen = new Set<string>();

    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const fragment of result.value) {
          if (fragments.length >= MAX_ENRICHMENT_FRAGMENTS) break;
          const hash = fragment.content;
          if (!seen.has(hash)) {
            seen.add(hash);
            fragments.push(fragment);
          }
        }
      }
      if (fragments.length >= MAX_ENRICHMENT_FRAGMENTS) break;
    }

    return fragments;
  }

  async onMemoryWrite(entry: MemoryEntry): Promise<void> {
    if (this.providers.length === 0) return;

    await Promise.allSettled(
      this.providers
        .filter((p) => p.capabilities.persistence)
        .map((p) => p.onMemoryWrite(entry)),
    );
  }

  async onTurnComplete(turn: CompletedTurn): Promise<void> {
    if (this.providers.length === 0) return;

    await Promise.allSettled(
      this.providers.map((p) => p.onTurnComplete(turn)),
    );
  }

  async onCompress(summary: CompressionSummary): Promise<void> {
    if (this.providers.length === 0) return;

    await Promise.allSettled(
      this.providers.map((p) => p.onCompress(summary)),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      this.providers.map((p) => p.shutdown()),
    );
    this.providers = [];
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _coordinator: MemoryCoordinator | null = null;

export function getMemoryCoordinator(): MemoryCoordinator {
  if (_coordinator === null) {
    _coordinator = new MemoryCoordinator();
  }
  return _coordinator;
}

export function setMemoryCoordinator(coordinator: MemoryCoordinator): void {
  _coordinator = coordinator;
}

export async function resetMemoryCoordinator(): Promise<void> {
  if (_coordinator) {
    await _coordinator.shutdown();
  }
  _coordinator = null;
}
