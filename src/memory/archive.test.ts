import { describe, it, expect, afterEach } from "vitest";
import {
  archiveSession,
  searchArchive,
  listArchive,
  resetArchiveStore,
} from "./archive.js";

afterEach(() => {
  resetArchiveStore();
});

// ---------------------------------------------------------------------------
// archiveSession
// ---------------------------------------------------------------------------

describe("archiveSession", () => {
  it("archives a session and makes it searchable", () => {
    archiveSession({
      sessionId: "s1",
      summary: "Implemented web search tool with DuckDuckGo backend",
      tags: ["web", "search", "tools"],
      toolsUsed: ["bash", "edit_file", "grep"],
    });

    const results = searchArchive("web search");
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe("s1");
    expect(results[0]!.summary).toContain("web search");
    expect(results[0]!.tags).toEqual(["web", "search", "tools"]);
    expect(results[0]!.toolsUsed).toEqual(["bash", "edit_file", "grep"]);
  });

  it("defaults tags and toolsUsed to empty arrays", () => {
    archiveSession({
      sessionId: "s2",
      summary: "Quick bugfix session",
    });

    const results = searchArchive("bugfix");
    expect(results).toHaveLength(1);
    expect(results[0]!.tags).toEqual([]);
    expect(results[0]!.toolsUsed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchArchive
// ---------------------------------------------------------------------------

describe("searchArchive", () => {
  it("returns empty array when no matches", () => {
    expect(searchArchive("nonexistent")).toEqual([]);
  });

  it("searches case-insensitively", () => {
    archiveSession({
      sessionId: "s1",
      summary: "Implemented TypeScript migration",
    });

    expect(searchArchive("typescript")).toHaveLength(1);
    expect(searchArchive("TYPESCRIPT")).toHaveLength(1);
  });

  it("searches in tags", () => {
    archiveSession({
      sessionId: "s1",
      summary: "Some work",
      tags: ["refactoring", "cleanup"],
    });

    expect(searchArchive("refactoring")).toHaveLength(1);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      archiveSession({
        sessionId: `s${i}`,
        summary: `Session ${i} about testing`,
      });
    }

    expect(searchArchive("testing", 3)).toHaveLength(3);
  });

  it("default limit is 5", () => {
    for (let i = 0; i < 10; i++) {
      archiveSession({
        sessionId: `s${i}`,
        summary: `Session ${i} about deployment`,
      });
    }

    expect(searchArchive("deployment")).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// listArchive
// ---------------------------------------------------------------------------

describe("listArchive", () => {
  it("lists all archived sessions", () => {
    archiveSession({ sessionId: "s1", summary: "First" });
    archiveSession({ sessionId: "s2", summary: "Second" });
    archiveSession({ sessionId: "s3", summary: "Third" });

    const results = listArchive();
    expect(results).toHaveLength(3);
    const ids = results.map((r) => r.sessionId).sort();
    expect(ids).toEqual(["s1", "s2", "s3"]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      archiveSession({ sessionId: `s${i}`, summary: `Session ${i}` });
    }

    expect(listArchive(3)).toHaveLength(3);
  });

  it("returns empty array when no sessions", () => {
    expect(listArchive()).toEqual([]);
  });
});
