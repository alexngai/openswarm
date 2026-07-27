/**
 * State database — SQLite-backed persistent store modeled on Codex state/ crate.
 *
 * Stores session metadata, memories, and audit logs. Uses better-sqlite3
 * for synchronous, single-process access. Migrations are applied automatically
 * on open.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

// Robust `require` for this ESM module — used to load the optional native
// backend and the built-in `node:sqlite` fallback synchronously.
const nodeRequire = createRequire(import.meta.url);

// better-sqlite3 types (subset used by StateDB)
interface BetterSqliteDB {
  pragma(source: string): unknown;
  prepare(source: string): BetterSqliteStatement;
  exec(source: string): void;
  transaction<T>(fn: () => T): () => T;
  close(): void;
  open: boolean;
}

interface BetterSqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Open the state database, preferring the native `better-sqlite3` driver and
 * falling back to Node's built-in `node:sqlite` (stable in Node ≥22) when the
 * native binding isn't built. The fallback needs no compile toolchain, so
 * StateDB works in environments where `better-sqlite3` was never built (e.g. a
 * fresh checkout on a new Node with no Xcode CLT) — while CI/prod that DO have
 * the native binding keep using it unchanged.
 */
function openStateDatabase(dbPath: string): BetterSqliteDB {
  try {
    const Database = nodeRequire("better-sqlite3");
    return new Database(dbPath) as BetterSqliteDB;
  } catch {
    return makeNodeSqliteAdapter(dbPath);
  }
}

/**
 * Adapt `node:sqlite`'s `DatabaseSync` to the small `better-sqlite3` surface
 * StateDB uses. Differences bridged: `.pragma()` → `exec("PRAGMA …")`;
 * `.transaction(fn)` → a BEGIN/COMMIT/ROLLBACK wrapper (StateDB's use is
 * single-level and immediately invoked); `.open` (boolean) ← `.isOpen`.
 * node:sqlite binds are strict (only null/number/bigint/string/Uint8Array), so
 * booleans/undefined are coerced — StateDB already passes `?? null`, this just
 * keeps the adapter robust for future callers.
 */
function makeNodeSqliteAdapter(dbPath: string): BetterSqliteDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { DatabaseSync } = nodeRequire("node:sqlite") as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = new DatabaseSync(dbPath);
  const coerce = (params: unknown[]): unknown[] =>
    params.map((p) =>
      typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p,
    );
  return {
    pragma: (source: string) => db.exec(`PRAGMA ${source}`),
    prepare: (source: string): BetterSqliteStatement => {
      const stmt = db.prepare(source);
      return {
        run: (...params: unknown[]) => stmt.run(...coerce(params)),
        get: (...params: unknown[]) => stmt.get(...coerce(params)),
        all: (...params: unknown[]) => stmt.all(...coerce(params)) as unknown[],
      };
    },
    exec: (source: string) => {
      db.exec(source);
    },
    transaction: <T,>(fn: () => T): (() => T) => {
      return () => {
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      };
    },
    close: () => db.close(),
    get open(): boolean {
      return db.isOpen;
    },
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  model: string;
  engineId: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  compactionCount: number;
  cwd: string;
}

export interface MemoryRecord {
  id: string;
  sessionId: string;
  category: string;
  content: string;
  confidence: number;
  createdAt: string;
}

export interface AuditRecord {
  id: string;
  sessionId: string;
  timestamp: string;
  action: string;
  toolName?: string;
  detail?: string;
}

export interface CuratedMemoryRow {
  scopeKey: string;
  content: string;
  updatedAt: string;
}

export interface SessionSummaryRow {
  sessionId: string;
  summary: string;
  tags: string;
  toolsUsed: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Migration system
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        model TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        tool_name TEXT,
        detail TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS curated_memory (
        scope_key  TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        summary    TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        tools_used TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
        summary, tags,
        content=session_summaries,
        content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, summary, tags) VALUES (new.rowid, new.summary, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary, tags) VALUES ('delete', old.rowid, old.summary, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, summary, tags) VALUES ('delete', old.rowid, old.summary, old.tags);
        INSERT INTO session_summaries_fts(rowid, summary, tags) VALUES (new.rowid, new.summary, new.tags);
      END;
    `,
  },
];

// ---------------------------------------------------------------------------
// StateDB
// ---------------------------------------------------------------------------

export class StateDB {
  private db: BetterSqliteDB;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = openStateDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.applyMigrations();
  }

  close(): void {
    this.db.close();
  }

  get isOpen(): boolean {
    return this.db.open;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  createSession(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, started_at, ended_at, model, engine_id, turn_count, input_tokens, output_tokens, compaction_count, cwd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.startedAt,
        record.endedAt ?? null,
        record.model,
        record.engineId,
        record.turnCount,
        record.inputTokens,
        record.outputTokens,
        record.compactionCount,
        record.cwd,
      );
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as any;
    return row ? mapSessionRow(row) : null;
  }

  updateSession(
    id: string,
    updates: Partial<
      Pick<SessionRecord, "endedAt" | "turnCount" | "inputTokens" | "outputTokens" | "compactionCount">
    >,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.endedAt !== undefined) {
      sets.push("ended_at = ?");
      values.push(updates.endedAt);
    }
    if (updates.turnCount !== undefined) {
      sets.push("turn_count = ?");
      values.push(updates.turnCount);
    }
    if (updates.inputTokens !== undefined) {
      sets.push("input_tokens = ?");
      values.push(updates.inputTokens);
    }
    if (updates.outputTokens !== undefined) {
      sets.push("output_tokens = ?");
      values.push(updates.outputTokens);
    }
    if (updates.compactionCount !== undefined) {
      sets.push("compaction_count = ?");
      values.push(updates.compactionCount);
    }

    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(mapSessionRow);
  }

  // -------------------------------------------------------------------------
  // Memories
  // -------------------------------------------------------------------------

  createMemory(record: MemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO memories (id, session_id, category, content, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.category,
        record.content,
        record.confidence,
        record.createdAt,
      );
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as any;
    return row ? mapMemoryRow(row) : null;
  }

  listMemories(opts?: {
    sessionId?: string;
    category?: string;
    limit?: number;
  }): MemoryRecord[] {
    let sql = "SELECT * FROM memories";
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (opts?.sessionId !== undefined) {
      conditions.push("session_id = ?");
      values.push(opts.sessionId);
    }
    if (opts?.category !== undefined) {
      conditions.push("category = ?");
      values.push(opts.category);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY created_at DESC";
    if (opts?.limit) {
      sql += " LIMIT ?";
      values.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...values) as any[];
    return rows.map(mapMemoryRow);
  }

  searchMemories(query: string, limit = 10): MemoryRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE content LIKE ? ORDER BY confidence DESC, created_at DESC LIMIT ?",
      )
      .all(`%${query}%`, limit) as any[];
    return rows.map(mapMemoryRow);
  }

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------

  logAudit(record: AuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (id, session_id, timestamp, action, tool_name, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.timestamp,
        record.action,
        record.toolName ?? null,
        record.detail ?? null,
      );
  }

  listAuditLog(sessionId: string, limit = 100): AuditRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(sessionId, limit) as any[];
    return rows.map(mapAuditRow);
  }

  // -------------------------------------------------------------------------
  // Session summaries
  // -------------------------------------------------------------------------

  createSessionSummary(record: SessionSummaryRow): void {
    this.db
      .prepare(
        `INSERT INTO session_summaries (session_id, summary, tags, tools_used, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, tags = excluded.tags, tools_used = excluded.tools_used, created_at = excluded.created_at`,
      )
      .run(
        record.sessionId,
        record.summary,
        record.tags,
        record.toolsUsed,
        record.createdAt,
      );
  }

  getSessionSummary(sessionId: string): SessionSummaryRow | null {
    const row = this.db
      .prepare("SELECT * FROM session_summaries WHERE session_id = ?")
      .get(sessionId) as any;
    return row ? mapSessionSummaryRow(row) : null;
  }

  searchSessionSummaries(query: string, limit = 10): SessionSummaryRow[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT s.* FROM session_summaries s
           JOIN session_summaries_fts f ON s.rowid = f.rowid
           WHERE session_summaries_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, limit) as any[];
      return rows.map(mapSessionSummaryRow);
    } catch {
      const rows = this.db
        .prepare(
          "SELECT * FROM session_summaries WHERE summary LIKE ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(`%${query}%`, limit) as any[];
      return rows.map(mapSessionSummaryRow);
    }
  }

  listSessionSummaries(limit = 20): SessionSummaryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM session_summaries ORDER BY created_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(mapSessionSummaryRow);
  }

  // -------------------------------------------------------------------------
  // Curated memory
  // -------------------------------------------------------------------------

  getCuratedMemory(scopeKey: string): CuratedMemoryRow | null {
    const row = this.db
      .prepare("SELECT * FROM curated_memory WHERE scope_key = ?")
      .get(scopeKey) as any;
    return row ? mapCuratedMemoryRow(row) : null;
  }

  setCuratedMemory(scopeKey: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO curated_memory (scope_key, content, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(scope_key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(scopeKey, content);
  }

  deleteCuratedMemory(scopeKey: string): void {
    this.db
      .prepare("DELETE FROM curated_memory WHERE scope_key = ?")
      .run(scopeKey);
  }

  listCuratedMemories(): CuratedMemoryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM curated_memory ORDER BY updated_at DESC")
      .all() as any[];
    return rows.map(mapCuratedMemoryRow);
  }

  // -------------------------------------------------------------------------
  // Schema version
  // -------------------------------------------------------------------------

  getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT MAX(version) as version FROM schema_version")
        .get() as any;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private applyMigrations(): void {
    const current = this.getSchemaVersion();

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;

      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_version (version) VALUES (?)")
          .run(migration.version);
      })();
    }
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapSessionRow(row: any): SessionRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    model: row.model,
    engineId: row.engine_id,
    turnCount: row.turn_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    compactionCount: row.compaction_count,
    cwd: row.cwd,
  };
}

function mapMemoryRow(row: any): MemoryRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    category: row.category,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function mapAuditRow(row: any): AuditRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    action: row.action,
    toolName: row.tool_name ?? undefined,
    detail: row.detail ?? undefined,
  };
}

function mapCuratedMemoryRow(row: any): CuratedMemoryRow {
  return {
    scopeKey: row.scope_key,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

function mapSessionSummaryRow(row: any): SessionSummaryRow {
  return {
    sessionId: row.session_id,
    summary: row.summary,
    tags: row.tags,
    toolsUsed: row.tools_used,
    createdAt: row.created_at,
  };
}

