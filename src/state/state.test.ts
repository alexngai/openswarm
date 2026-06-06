import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { StateDB } from "./index.js";

let tmpDir: string;
let db: StateDB;

function freshDB(): StateDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "statedb-"));
  const dbPath = path.join(tmpDir, "test-state.db");
  return new StateDB(dbPath);
}

afterEach(() => {
  if (db?.isOpen) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Schema & lifecycle
// ---------------------------------------------------------------------------

describe("StateDB lifecycle", () => {
  it("creates database and applies migrations", () => {
    db = freshDB();
    expect(db.isOpen).toBe(true);
    expect(db.getSchemaVersion()).toBe(1);
  });

  it("creates parent directory if needed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "statedb-"));
    const nested = path.join(tmpDir, "a", "b", "c", "state.db");
    db = new StateDB(nested);
    expect(db.isOpen).toBe(true);
    db.close();
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("reopens existing database", () => {
    db = freshDB();
    const dbPath = path.join(tmpDir, "test-state.db");
    db.createSession({
      id: "s1",
      startedAt: new Date().toISOString(),
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });
    db.close();

    db = new StateDB(dbPath);
    expect(db.getSession("s1")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("Sessions CRUD", () => {
  it("creates and retrieves a session", () => {
    db = freshDB();
    const id = crypto.randomUUID();
    db.createSession({
      id,
      startedAt: "2026-06-05T00:00:00Z",
      model: "claude-sonnet-4-6",
      engineId: "hardened-native",
      turnCount: 5,
      inputTokens: 1000,
      outputTokens: 500,
      compactionCount: 1,
      cwd: "/home/user/project",
    });

    const session = db.getSession(id);
    expect(session).not.toBeNull();
    expect(session!.model).toBe("claude-sonnet-4-6");
    expect(session!.turnCount).toBe(5);
    expect(session!.inputTokens).toBe(1000);
    expect(session!.cwd).toBe("/home/user/project");
  });

  it("returns null for missing session", () => {
    db = freshDB();
    expect(db.getSession("nonexistent")).toBeNull();
  });

  it("updates session fields", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.updateSession("s1", {
      turnCount: 10,
      inputTokens: 5000,
      outputTokens: 2500,
      endedAt: "2026-06-05T01:00:00Z",
    });

    const session = db.getSession("s1")!;
    expect(session.turnCount).toBe(10);
    expect(session.inputTokens).toBe(5000);
    expect(session.endedAt).toBe("2026-06-05T01:00:00Z");
  });

  it("lists sessions in reverse chronological order", () => {
    db = freshDB();
    for (let i = 0; i < 5; i++) {
      db.createSession({
        id: `s${i}`,
        startedAt: `2026-06-0${i + 1}T00:00:00Z`,
        model: "test",
        engineId: "native",
        turnCount: i,
        inputTokens: 0,
        outputTokens: 0,
        compactionCount: 0,
        cwd: "/tmp",
      });
    }

    const sessions = db.listSessions(3);
    expect(sessions).toHaveLength(3);
    expect(sessions[0]!.id).toBe("s4");
    expect(sessions[2]!.id).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

describe("Goals CRUD", () => {
  it("creates and retrieves a goal", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.createGoal({
      id: "g1",
      sessionId: "s1",
      status: "active",
      description: "Implement feature X",
      tokenBudget: 50000,
      tokensUsed: 1000,
      turnCount: 3,
      createdAt: "2026-06-05T00:00:00Z",
      updatedAt: "2026-06-05T00:05:00Z",
    });

    const goal = db.getGoal("g1");
    expect(goal).not.toBeNull();
    expect(goal!.description).toBe("Implement feature X");
    expect(goal!.tokenBudget).toBe(50000);
    expect(goal!.status).toBe("active");
  });

  it("updates goal status and usage", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.createGoal({
      id: "g1",
      sessionId: "s1",
      status: "active",
      description: "test",
      tokensUsed: 0,
      turnCount: 0,
      createdAt: "2026-06-05T00:00:00Z",
      updatedAt: "2026-06-05T00:00:00Z",
    });

    db.updateGoal("g1", {
      status: "usage_limited",
      tokensUsed: 50000,
      turnCount: 20,
      updatedAt: "2026-06-05T01:00:00Z",
    });

    const goal = db.getGoal("g1")!;
    expect(goal.status).toBe("usage_limited");
    expect(goal.tokensUsed).toBe(50000);
  });

  it("lists goals by session and status", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.createGoal({
      id: "g1",
      sessionId: "s1",
      status: "active",
      description: "first",
      tokensUsed: 0,
      turnCount: 0,
      createdAt: "2026-06-05T00:01:00Z",
      updatedAt: "2026-06-05T00:01:00Z",
    });

    db.createGoal({
      id: "g2",
      sessionId: "s1",
      status: "complete",
      description: "second",
      tokensUsed: 100,
      turnCount: 1,
      createdAt: "2026-06-05T00:02:00Z",
      updatedAt: "2026-06-05T00:02:00Z",
    });

    expect(db.listGoals("s1")).toHaveLength(2);
    expect(db.listGoals("s1", "active")).toHaveLength(1);
    expect(db.listGoals("s1", "complete")).toHaveLength(1);
    expect(db.listGoals("s1", "paused")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

describe("Memories CRUD", () => {
  it("creates and retrieves memories", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.createMemory({
      id: "m1",
      sessionId: "s1",
      category: "preference",
      content: "User prefers TypeScript over JavaScript",
      confidence: 0.95,
      createdAt: "2026-06-05T00:00:00Z",
    });

    const mem = db.getMemory("m1");
    expect(mem).not.toBeNull();
    expect(mem!.category).toBe("preference");
    expect(mem!.confidence).toBe(0.95);
  });

  it("searches memories by content", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.createMemory({
      id: "m1",
      sessionId: "s1",
      category: "fact",
      content: "Project uses Vitest for testing",
      confidence: 1.0,
      createdAt: "2026-06-05T00:00:00Z",
    });

    db.createMemory({
      id: "m2",
      sessionId: "s1",
      category: "fact",
      content: "Project uses ESLint for linting",
      confidence: 0.9,
      createdAt: "2026-06-05T00:01:00Z",
    });

    const results = db.searchMemories("Vitest");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("lists memories by category", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.createMemory({
      id: "m1",
      sessionId: "s1",
      category: "preference",
      content: "a",
      confidence: 1.0,
      createdAt: "2026-06-05T00:00:00Z",
    });

    db.createMemory({
      id: "m2",
      sessionId: "s1",
      category: "fact",
      content: "b",
      confidence: 1.0,
      createdAt: "2026-06-05T00:01:00Z",
    });

    expect(db.listMemories({ category: "preference" })).toHaveLength(1);
    expect(db.listMemories({ category: "fact" })).toHaveLength(1);
    expect(db.listMemories({ sessionId: "s1" })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe("Audit log", () => {
  it("logs and retrieves audit entries", () => {
    db = freshDB();
    db.createSession({
      id: "s1",
      startedAt: "2026-06-05T00:00:00Z",
      model: "test",
      engineId: "native",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      compactionCount: 0,
      cwd: "/tmp",
    });

    db.logAudit({
      id: "a1",
      sessionId: "s1",
      timestamp: "2026-06-05T00:00:01Z",
      action: "tool_call",
      toolName: "bash",
      detail: "ls -la",
    });

    db.logAudit({
      id: "a2",
      sessionId: "s1",
      timestamp: "2026-06-05T00:00:02Z",
      action: "permission_granted",
    });

    const logs = db.listAuditLog("s1");
    expect(logs).toHaveLength(2);
    expect(logs[0]!.timestamp).toBe("2026-06-05T00:00:02Z");
    expect(logs[1]!.toolName).toBe("bash");
  });
});
