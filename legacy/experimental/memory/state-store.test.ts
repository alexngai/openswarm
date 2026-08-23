import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateDB } from "../../src/state/index.js";
import { StateDBCuratedStore, StateDBArchiveStore } from "./state-store.js";

let tmpDir: string;
let db: StateDB;

function freshDB(): StateDB {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "curated-store-"));
  return new StateDB(path.join(tmpDir, "test.db"));
}

afterEach(() => {
  if (db?.isOpen) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("StateDBCuratedStore", () => {
  it("stores and retrieves curated memory", () => {
    db = freshDB();
    const store = new StateDBCuratedStore(db);

    store.set("project:/test", "Line one\nLine two");
    const record = store.get("project:/test");

    expect(record).not.toBeNull();
    expect(record!.scopeKey).toBe("project:/test");
    expect(record!.content).toBe("Line one\nLine two");
    expect(record!.updatedAt).toBeTruthy();
  });

  it("returns null for missing key", () => {
    db = freshDB();
    const store = new StateDBCuratedStore(db);
    expect(store.get("user:nobody")).toBeNull();
  });

  it("upserts existing key", () => {
    db = freshDB();
    const store = new StateDBCuratedStore(db);

    store.set("user:alice", "Version 1");
    store.set("user:alice", "Version 2");
    const record = store.get("user:alice");
    expect(record!.content).toBe("Version 2");
  });

  it("persists across store instances (same DB)", () => {
    db = freshDB();
    const store1 = new StateDBCuratedStore(db);
    store1.set("project:/repo", "Persistent data");

    const store2 = new StateDBCuratedStore(db);
    const record = store2.get("project:/repo");
    expect(record!.content).toBe("Persistent data");
  });
});

describe("StateDBArchiveStore", () => {
  it("saves and retrieves session summaries", () => {
    db = freshDB();
    const store = new StateDBArchiveStore(db);

    store.save({
      sessionId: "s1",
      summary: "Built the memory system",
      tags: '["memory","architecture"]',
      toolsUsed: '["bash","grep"]',
      createdAt: "2026-06-05T00:00:00Z",
    });

    const record = store.get("s1");
    expect(record).not.toBeNull();
    expect(record!.summary).toContain("memory system");
    expect(record!.tags).toBe('["memory","architecture"]');
  });

  it("returns null for missing session", () => {
    db = freshDB();
    const store = new StateDBArchiveStore(db);
    expect(store.get("nope")).toBeNull();
  });

  it("searches via FTS5", () => {
    db = freshDB();
    const store = new StateDBArchiveStore(db);

    store.save({
      sessionId: "s1",
      summary: "Implemented TypeScript migration",
      tags: "[]",
      toolsUsed: "[]",
      createdAt: "2026-06-05T00:00:00Z",
    });
    store.save({
      sessionId: "s2",
      summary: "Fixed Python linting errors",
      tags: "[]",
      toolsUsed: "[]",
      createdAt: "2026-06-05T01:00:00Z",
    });

    const results = store.search("TypeScript");
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe("s1");
  });

  it("lists in reverse chronological order", () => {
    db = freshDB();
    const store = new StateDBArchiveStore(db);

    store.save({
      sessionId: "s1",
      summary: "First",
      tags: "[]",
      toolsUsed: "[]",
      createdAt: "2026-06-01T00:00:00Z",
    });
    store.save({
      sessionId: "s2",
      summary: "Second",
      tags: "[]",
      toolsUsed: "[]",
      createdAt: "2026-06-02T00:00:00Z",
    });

    const results = store.list();
    expect(results).toHaveLength(2);
    expect(results[0]!.sessionId).toBe("s2");
  });
});
