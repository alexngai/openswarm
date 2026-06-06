import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateDB } from "../state/index.js";
import { StateDBCuratedStore } from "./state-store.js";

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
