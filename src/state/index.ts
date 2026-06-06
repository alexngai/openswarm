/**
 * State database — SQLite-backed persistent store modeled on Codex state/ crate.
 *
 * Stores session metadata, goals, memories, and audit logs. Uses better-sqlite3
 * for synchronous, single-process access. Migrations are applied automatically
 * on open.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export interface GoalRecord {
  id: string;
  sessionId: string;
  parentGoalId?: string;
  status: GoalStatus;
  description: string;
  tokenBudget?: number;
  tokensUsed: number;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  checkpoint?: string;
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

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_goal_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        description TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        checkpoint TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
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

      CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
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

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    this.db = new Database(dbPath) as BetterSqliteDB;
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
  // Goals
  // -------------------------------------------------------------------------

  createGoal(record: GoalRecord): void {
    this.db
      .prepare(
        `INSERT INTO goals (id, session_id, parent_goal_id, status, description, token_budget, tokens_used, turn_count, created_at, updated_at, checkpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.parentGoalId ?? null,
        record.status,
        record.description,
        record.tokenBudget ?? null,
        record.tokensUsed,
        record.turnCount,
        record.createdAt,
        record.updatedAt,
        record.checkpoint ?? null,
      );
  }

  getGoal(id: string): GoalRecord | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as any;
    return row ? mapGoalRow(row) : null;
  }

  updateGoal(
    id: string,
    updates: Partial<
      Pick<GoalRecord, "status" | "tokensUsed" | "turnCount" | "checkpoint" | "updatedAt">
    >,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.tokensUsed !== undefined) {
      sets.push("tokens_used = ?");
      values.push(updates.tokensUsed);
    }
    if (updates.turnCount !== undefined) {
      sets.push("turn_count = ?");
      values.push(updates.turnCount);
    }
    if (updates.checkpoint !== undefined) {
      sets.push("checkpoint = ?");
      values.push(updates.checkpoint);
    }
    if (updates.updatedAt !== undefined) {
      sets.push("updated_at = ?");
      values.push(updates.updatedAt);
    }

    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  listGoals(sessionId?: string, status?: GoalStatus): GoalRecord[] {
    let sql = "SELECT * FROM goals";
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (sessionId !== undefined) {
      conditions.push("session_id = ?");
      values.push(sessionId);
    }
    if (status !== undefined) {
      conditions.push("status = ?");
      values.push(status);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY created_at DESC";

    const rows = this.db.prepare(sql).all(...values) as any[];
    return rows.map(mapGoalRow);
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

function mapGoalRow(row: any): GoalRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentGoalId: row.parent_goal_id ?? undefined,
    status: row.status,
    description: row.description,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    checkpoint: row.checkpoint ?? undefined,
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

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let stateDB: StateDB | null = null;

export function getStateDB(dbPath?: string): StateDB {
  if (stateDB === null) {
    const resolvedPath =
      dbPath ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".swarm-harness",
        "state.db",
      );
    stateDB = new StateDB(resolvedPath);
  }
  return stateDB;
}

export function setStateDB(db: StateDB): void {
  stateDB = db;
}

export function resetStateDB(): void {
  if (stateDB !== null) {
    try {
      stateDB.close();
    } catch {
      // ignore close errors during reset
    }
  }
  stateDB = null;
}
