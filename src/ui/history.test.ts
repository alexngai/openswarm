import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import {
  loadHistory,
  appendHistoryEntry,
  HISTORY_CAP,
  DEFAULT_HISTORY_PATH,
} from "./history.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fresh isolated temp file path for each test. */
function tmpFile(): string {
  return path.join(os.tmpdir(), `history-test-${crypto.randomUUID()}`);
}

// ---------------------------------------------------------------------------
// loadHistory
// ---------------------------------------------------------------------------

describe("loadHistory", () => {
  it("missing file returns empty array", () => {
    const result = loadHistory("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual([]);
  });

  it("empty file returns empty array", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "", "utf8");
    expect(loadHistory(file)).toEqual([]);
    fs.unlinkSync(file);
  });

  it("round-trip: save then load returns original entries", () => {
    const file = tmpFile();
    appendHistoryEntry("foo", file);
    appendHistoryEntry("bar", file);
    appendHistoryEntry("baz", file);
    const result = loadHistory(file);
    expect(result).toEqual(["foo", "bar", "baz"]);
    fs.unlinkSync(file);
  });

  it("restores \\n within entries (multi-line escape/unescape)", () => {
    const file = tmpFile();
    const multiLine = "first line\nsecond line";
    appendHistoryEntry(multiLine, file);
    const result = loadHistory(file);
    expect(result).toEqual([multiLine]);
    fs.unlinkSync(file);
  });

  it("restores \\r within entries", () => {
    const file = tmpFile();
    const entry = "line with\rcarriage";
    appendHistoryEntry(entry, file);
    const result = loadHistory(file);
    expect(result).toEqual([entry]);
    fs.unlinkSync(file);
  });

  it("preserves line ordering (oldest first)", () => {
    const file = tmpFile();
    const entries = ["alpha", "beta", "gamma", "delta"];
    for (const e of entries) {
      appendHistoryEntry(e, file);
    }
    const result = loadHistory(file);
    expect(result).toEqual(entries);
    fs.unlinkSync(file);
  });
});

// ---------------------------------------------------------------------------
// appendHistoryEntry
// ---------------------------------------------------------------------------

describe("appendHistoryEntry", () => {
  it("skips blank entries (whitespace-only)", () => {
    const file = tmpFile();
    appendHistoryEntry("", file);
    appendHistoryEntry("   ", file);
    appendHistoryEntry("\t", file);
    expect(loadHistory(file)).toEqual([]);
    // File may not exist at all — that's fine.
  });

  it("skips consecutive duplicates", () => {
    const file = tmpFile();
    appendHistoryEntry("hello", file);
    appendHistoryEntry("hello", file);
    expect(loadHistory(file)).toEqual(["hello"]);
    fs.unlinkSync(file);
  });

  it("keeps non-consecutive duplicates", () => {
    const file = tmpFile();
    appendHistoryEntry("foo", file);
    appendHistoryEntry("bar", file);
    appendHistoryEntry("foo", file);
    expect(loadHistory(file)).toEqual(["foo", "bar", "foo"]);
    fs.unlinkSync(file);
  });

  it("creates parent directory if missing", () => {
    const dir = path.join(os.tmpdir(), `hist-dir-${crypto.randomUUID()}`);
    const file = path.join(dir, "nested", "history");
    appendHistoryEntry("test", file);
    expect(loadHistory(file)).toEqual(["test"]);
    fs.rmSync(dir, { recursive: true });
  });

  it("multi-line entries survive escape/unescape round-trip", () => {
    const file = tmpFile();
    const entry = "line one\nline two\nline three";
    appendHistoryEntry(entry, file);
    const raw = fs.readFileSync(file, "utf8");
    // Raw file must contain only one line (SOH-escaped).
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    // Loaded result must restore the original.
    expect(loadHistory(file)).toEqual([entry]);
    fs.unlinkSync(file);
  });

  it("overflow truncates from front (oldest entries dropped)", () => {
    const file = tmpFile();
    // Write HISTORY_CAP entries.
    const lines: string[] = [];
    for (let i = 0; i < HISTORY_CAP; i++) {
      lines.push(`entry-${i}`);
    }
    // Write directly to avoid the O(n^2) loop through appendHistoryEntry.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");

    // Now append one more — should trigger rewrite dropping "entry-0".
    appendHistoryEntry("overflow-entry", file);
    const result = loadHistory(file);
    expect(result).toHaveLength(HISTORY_CAP);
    expect(result[0]).toBe("entry-1");
    expect(result[result.length - 1]).toBe("overflow-entry");
    fs.unlinkSync(file);
  });

  it("overflow: file never exceeds HISTORY_CAP lines after rewrite", () => {
    const file = tmpFile();
    // Write HISTORY_CAP + 5 entries via direct write then append.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bulkLines: string[] = [];
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      bulkLines.push(`line-${i}`);
    }
    fs.writeFileSync(file, bulkLines.join("\n") + "\n", "utf8");
    // Append triggers rewrite.
    appendHistoryEntry("final", file);
    const result = loadHistory(file);
    expect(result.length).toBeLessThanOrEqual(HISTORY_CAP);
    fs.unlinkSync(file);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_HISTORY_PATH
// ---------------------------------------------------------------------------

describe("DEFAULT_HISTORY_PATH", () => {
  it("uses os.homedir() not a raw tilde", () => {
    expect(DEFAULT_HISTORY_PATH).not.toContain("~");
    expect(DEFAULT_HISTORY_PATH).toContain(os.homedir());
  });

  it("ends with .openswarm/history", () => {
    expect(DEFAULT_HISTORY_PATH).toMatch(/\.openswarm[/\\]history$/);
  });
});
