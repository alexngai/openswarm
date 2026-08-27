/**
 * Session archive (Layer 3) — archives completed sessions for long-term recall.
 *
 * At session end, the archive captures a summary, tags, and tool usage.
 * Past sessions can be searched via FTS5 full-text search with fallback
 * to LIKE-based search if FTS fails.
 */

import type { SessionSummaryRow } from "../state/index.js";

// ---------------------------------------------------------------------------
// Archive store interface
// ---------------------------------------------------------------------------

export interface ArchiveStore {
  save(record: SessionSummaryRow): void;
  get(sessionId: string): SessionSummaryRow | null;
  search(query: string, limit?: number): SessionSummaryRow[];
  list(limit?: number): SessionSummaryRow[];
}

// ---------------------------------------------------------------------------
// In-memory store (for testing / when no StateDB is available)
// ---------------------------------------------------------------------------

class InMemoryArchiveStore implements ArchiveStore {
  private data = new Map<string, SessionSummaryRow>();

  save(record: SessionSummaryRow): void {
    this.data.set(record.sessionId, record);
  }

  get(sessionId: string): SessionSummaryRow | null {
    return this.data.get(sessionId) ?? null;
  }

  search(query: string, limit = 10): SessionSummaryRow[] {
    const lower = query.toLowerCase();
    const results: SessionSummaryRow[] = [];
    for (const record of this.data.values()) {
      if (
        record.summary.toLowerCase().includes(lower) ||
        record.tags.toLowerCase().includes(lower)
      ) {
        results.push(record);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  list(limit = 20): SessionSummaryRow[] {
    const all = [...this.data.values()];
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _store: ArchiveStore = new InMemoryArchiveStore();
let _explicit = false;

export function getArchiveStore(): ArchiveStore {
  return _store;
}

export function setArchiveStore(store: ArchiveStore): void {
  _store = store;
  _explicit = true;
}

/**
 * Install a store only when no caller has explicitly chosen one (Phase 3 B2).
 * The FileMemoryProvider uses this to swap the volatile in-memory default for
 * the durable FileArchiveStore without clobbering test doubles installed via
 * setArchiveStore.
 */
export function installDefaultArchiveStore(store: ArchiveStore): void {
  if (_explicit) return;
  _store = store;
}

export function resetArchiveStore(): void {
  _store = new InMemoryArchiveStore();
  _explicit = false;
}

// ---------------------------------------------------------------------------
// Archive a session
// ---------------------------------------------------------------------------

export interface ArchiveSessionInput {
  sessionId: string;
  summary: string;
  tags?: string[];
  toolsUsed?: string[];
}

export function archiveSession(input: ArchiveSessionInput): void {
  const store = getArchiveStore();
  store.save({
    sessionId: input.sessionId,
    summary: input.summary,
    tags: JSON.stringify(input.tags ?? []),
    toolsUsed: JSON.stringify(input.toolsUsed ?? []),
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Search archived sessions
// ---------------------------------------------------------------------------

export interface ArchiveSearchResult {
  sessionId: string;
  summary: string;
  tags: string[];
  toolsUsed: string[];
  createdAt: string;
}

function parseRow(row: SessionSummaryRow): ArchiveSearchResult {
  let tags: string[] = [];
  let toolsUsed: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch { /* empty */ }
  try {
    toolsUsed = JSON.parse(row.toolsUsed);
  } catch { /* empty */ }
  return {
    sessionId: row.sessionId,
    summary: row.summary,
    tags,
    toolsUsed,
    createdAt: row.createdAt,
  };
}

export function searchArchive(query: string, limit = 5): ArchiveSearchResult[] {
  const store = getArchiveStore();
  return store.search(query, limit).map(parseRow);
}

export function listArchive(limit = 10): ArchiveSearchResult[] {
  const store = getArchiveStore();
  return store.list(limit).map(parseRow);
}
