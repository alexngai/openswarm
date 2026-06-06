/**
 * StateDB-backed curated memory store.
 *
 * Bridges the curated memory module (Layer 1) to the StateDB persistence
 * layer, so curated memories survive across process restarts.
 */

import type { StateDB, CuratedMemoryRow } from "../state/index.js";
import type { CuratedMemoryStore } from "./curated.js";
import type { CuratedMemoryRecord } from "./types.js";

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
