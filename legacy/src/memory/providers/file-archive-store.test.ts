import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileArchiveStore } from "./file-archive-store.js";
import type { SessionSummaryRow } from "../../state/index.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "file-archive-"));
  file = join(dir, "nested", "session-archive.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function row(sessionId: string, summary: string, createdAt: string): SessionSummaryRow {
  return {
    sessionId,
    summary,
    tags: JSON.stringify(["tag-" + sessionId]),
    toolsUsed: JSON.stringify(["bash"]),
    createdAt,
  };
}

describe("FileArchiveStore (Phase 3 B2)", () => {
  it("save/get roundtrip creates parent directories and persists JSONL", async () => {
    const store = new FileArchiveStore(file);
    store.save(row("s-1", "fixed the login bug", "2026-07-01T00:00:00Z"));

    expect(store.get("s-1")!.summary).toBe("fixed the login bug");
    expect(store.get("missing")).toBeNull();

    // A brand-new store instance reads the same file (durability).
    expect(new FileArchiveStore(file).get("s-1")!.summary).toBe("fixed the login bug");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("last write wins for a re-archived session", () => {
    const store = new FileArchiveStore(file);
    store.save(row("s-1", "first", "2026-07-01T00:00:00Z"));
    store.save(row("s-1", "second", "2026-07-01T01:00:00Z"));
    expect(store.get("s-1")!.summary).toBe("second");
  });

  it("search matches summary and tags case-insensitively, newest first", () => {
    const store = new FileArchiveStore(file);
    store.save(row("s-1", "Refactored the parser", "2026-07-01T00:00:00Z"));
    store.save(row("s-2", "parser follow-up work", "2026-07-01T01:00:00Z"));
    store.save(row("s-3", "unrelated", "2026-07-01T02:00:00Z"));

    const results = store.search("PARSER");
    expect(results.map((r) => r.sessionId)).toEqual(["s-2", "s-1"]);
    // Tag match:
    expect(store.search("tag-s-3").map((r) => r.sessionId)).toEqual(["s-3"]);
    expect(store.search("nothing")).toEqual([]);
  });

  it("list sorts newest first and respects the limit", () => {
    const store = new FileArchiveStore(file);
    store.save(row("s-1", "a", "2026-07-01T00:00:00Z"));
    store.save(row("s-2", "b", "2026-07-01T02:00:00Z"));
    store.save(row("s-3", "c", "2026-07-01T01:00:00Z"));
    expect(store.list(2).map((r) => r.sessionId)).toEqual(["s-2", "s-3"]);
  });

  it("skips corrupt and foreign lines", async () => {
    const store = new FileArchiveStore(file);
    store.save(row("s-1", "good", "2026-07-01T00:00:00Z"));
    await writeFile(
      file,
      (await readFile(file, "utf8")) + "not json\n" + JSON.stringify({ other: true }) + "\n",
    );
    expect(store.list().map((r) => r.sessionId)).toEqual(["s-1"]);
  });

  it("read operations on a missing file return empty results", () => {
    const store = new FileArchiveStore(join(dir, "does-not-exist.jsonl"));
    expect(store.get("x")).toBeNull();
    expect(store.search("x")).toEqual([]);
    expect(store.list()).toEqual([]);
  });
});
