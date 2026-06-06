/**
 * Per-agent memory isolation — each agent in a swarm gets its own memory scope.
 *
 * Agent-scoped curated memory uses keys like: project:/repo:agent:worker-1
 * Shared memory is published to a common scope visible to all agents.
 */

import type { AgentId } from "../core/types.js";
import { scopeKey } from "./curated.js";

// ---------------------------------------------------------------------------
// Agent-scoped keys
// ---------------------------------------------------------------------------

export function agentScopeKey(
  scope: "project" | "user",
  identifier: string,
  agentId: AgentId,
): string {
  return `${scopeKey(scope, identifier)}:agent:${agentId}`;
}

// ---------------------------------------------------------------------------
// Shared memory bus
// ---------------------------------------------------------------------------

export interface SharedMemoryEntry {
  readonly publishedBy: AgentId;
  readonly content: string;
  readonly tags: readonly string[];
  readonly timestamp: string;
}

const MAX_SHARED_ENTRIES = 500;

let _sharedEntries: SharedMemoryEntry[] = [];

export function publishSharedMemory(entry: SharedMemoryEntry): void {
  _sharedEntries.push(entry);
  if (_sharedEntries.length > MAX_SHARED_ENTRIES) {
    _sharedEntries = _sharedEntries.slice(-MAX_SHARED_ENTRIES);
  }
}

export function getSharedMemory(opts?: {
  tags?: readonly string[];
  limit?: number;
}): SharedMemoryEntry[] {
  let results = [..._sharedEntries];

  if (opts?.tags && opts.tags.length > 0) {
    const filterTags = new Set(opts.tags.map((t) => t.toLowerCase()));
    results = results.filter((e) =>
      e.tags.some((t) => filterTags.has(t.toLowerCase())),
    );
  }

  results.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  if (opts?.limit) {
    results = results.slice(0, opts.limit);
  }

  return results;
}

export function resetSharedMemory(): void {
  _sharedEntries = [];
}

export function formatSharedMemory(entries: SharedMemoryEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries
    .map(
      (e) =>
        `[${e.publishedBy}] ${e.content}` +
        (e.tags.length > 0 ? ` (${e.tags.join(", ")})` : ""),
    )
    .join("\n");
}
