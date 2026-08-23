/**
 * StateDB-backed stores for the memory system.
 *
 * Bridges curated memory (Layer 1) and session archive (Layer 3) to the
 * StateDB persistence layer.
 */

import type { StateDB, CuratedMemoryRow, SessionSummaryRow } from "../../src/state/index.js";
import type { CuratedMemoryStore } from "../../src/memory/curated.js";
import type { ArchiveStore } from "../../src/memory/archive.js";
import type { CuratedMemoryRecord } from "../../src/memory/types.js";

export class StateDBCuratedStore implements CuratedMemoryStore {
  constructor(private db: StateDB) {}

  get(scopeKey: string): CuratedMemoryRecord | null {
    const row: CuratedMemoryRow | null = this.db.getCuratedMemory(scopeKey);
    if (!row) return null;
    return {
      scopeKey: row.scopeKey,
      content: row.content,
      updatedAt: row.updatedAt,
    };
  }

  set(scopeKey: string, content: string): void {
    this.db.setCuratedMemory(scopeKey, content);
  }
}

export class StateDBArchiveStore implements ArchiveStore {
  constructor(private db: StateDB) {}

  save(record: SessionSummaryRow): void {
    this.db.createSessionSummary(record);
  }

  get(sessionId: string): SessionSummaryRow | null {
    return this.db.getSessionSummary(sessionId);
  }

  search(query: string, limit = 10): SessionSummaryRow[] {
    return this.db.searchSessionSummaries(query, limit);
  }

  list(limit = 20): SessionSummaryRow[] {
    return this.db.listSessionSummaries(limit);
  }
}
