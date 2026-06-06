/**
 * Memory lifecycle integration — connects the MemoryCoordinator to the engine's
 * turn loop via clean lifecycle hooks.
 *
 * These functions are called at specific points in the engine lifecycle:
 * - onSessionStart: initialize coordinator with default providers
 * - onBeforeTurn: enrich the system prompt with memory context
 * - onAfterTurn: notify providers that a turn completed
 * - onCompaction: notify providers of context compression
 * - onSessionEnd: archive session and shut down providers
 */

import type { MemoryFragment, TurnContext, CompressionSummary } from "./types.js";
import { getMemoryCoordinator } from "./coordinator.js";
import { FileMemoryProvider } from "./providers/file-provider.js";
import { MinimemProvider } from "./providers/minimem-provider.js";
import { archiveSession } from "./archive.js";

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface SessionStartOptions {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly projectRoot?: string;
  readonly userId?: string;
}

export async function onSessionStart(opts?: SessionStartOptions): Promise<void> {
  const coordinator = getMemoryCoordinator();

  // Register the built-in FileMemoryProvider if not already present
  if (!coordinator.providerNames.includes("file")) {
    await coordinator.register(new FileMemoryProvider());
  }

  // Register MinimemProvider if not already present and not disabled
  if (
    !coordinator.providerNames.includes("minimem") &&
    process.env.SWARM_MEMORY_PROVIDERS !== "file"
  ) {
    const minimemProvider = new MinimemProvider();
    try {
      await coordinator.register(minimemProvider);
      if (!(await minimemProvider.isAvailable())) {
        await coordinator.unregister("minimem");
      }
    } catch {
      // minimem not available — no-op, file provider handles basics
    }
  }
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export async function onBeforeTurn(
  context: TurnContext,
): Promise<MemoryFragment[]> {
  const coordinator = getMemoryCoordinator();
  return coordinator.enrichTurn(context);
}

export function formatMemoryFragments(fragments: MemoryFragment[]): string | null {
  if (fragments.length === 0) return null;

  const sections: string[] = [];
  for (const fragment of fragments) {
    sections.push(fragment.content);
  }
  return sections.join("\n\n");
}

export interface TurnCompleteInfo {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly turnIndex: number;
  readonly toolsUsed: readonly string[];
  readonly summary?: string;
}

export async function onAfterTurn(info: TurnCompleteInfo): Promise<void> {
  const coordinator = getMemoryCoordinator();
  await coordinator.onTurnComplete({
    sessionId: info.sessionId,
    agentId: info.agentId as any,
    turnIndex: info.turnIndex,
    toolsUsed: info.toolsUsed,
    summary: info.summary,
  });
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export async function onCompaction(summary: CompressionSummary): Promise<void> {
  const coordinator = getMemoryCoordinator();
  await coordinator.onCompress(summary);
}

// ---------------------------------------------------------------------------
// Session end
// ---------------------------------------------------------------------------

export interface SessionEndInfo {
  readonly sessionId: string;
  readonly summary: string;
  readonly tags?: string[];
  readonly toolsUsed?: string[];
}

export async function onSessionEnd(info: SessionEndInfo): Promise<void> {
  // Archive the session
  archiveSession({
    sessionId: info.sessionId,
    summary: info.summary,
    tags: info.tags,
    toolsUsed: info.toolsUsed,
  });

  // Shut down all providers
  const coordinator = getMemoryCoordinator();
  await coordinator.shutdown();
}
