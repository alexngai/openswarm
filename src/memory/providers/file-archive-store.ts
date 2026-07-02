/**
 * FileArchiveStore — durable session archive backed by a JSONL file
 * (Phase 3 B2). Default location: `~/.openswarm/memory/session-archive.jsonl`.
 *
 * This is the file-provider fallback for archive persistence: minimem (when
 * available) also receives session summaries via the coordinator's
 * onMemoryWrite fan-out, but this store works with zero dependencies and
 * survives process exit — unlike the in-memory default in archive.ts.
 *
 * Reads scan the file on demand (session archives are small — one line per
 * session); writes append synchronously so session-end persistence can't be
 * lost to an early exit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionSummaryRow } from "../../state/index.js";
import type { ArchiveStore } from "../archive.js";

function defaultArchivePath(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".openswarm",
    "memory",
    "session-archive.jsonl",
  );
}

function isSessionSummaryRow(value: unknown): value is SessionSummaryRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.sessionId === "string" &&
    typeof row.summary === "string" &&
    typeof row.tags === "string" &&
    typeof row.toolsUsed === "string" &&
    typeof row.createdAt === "string"
  );
}

export class FileArchiveStore implements ArchiveStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultArchivePath();
  }

  save(record: SessionSummaryRow): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // best-effort — archive persistence must never fail session end
    }
  }

  private readAll(): SessionSummaryRow[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    const rows: SessionSummaryRow[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isSessionSummaryRow(parsed)) rows.push(parsed);
      } catch {
        // skip corrupt lines
      }
    }
    return rows;
  }

  get(sessionId: string): SessionSummaryRow | null {
    const rows = this.readAll();
    // Last write wins when a session was archived more than once.
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.sessionId === sessionId) return rows[i]!;
    }
    return null;
  }

  search(query: string, limit = 10): SessionSummaryRow[] {
    const lower = query.toLowerCase();
    const results: SessionSummaryRow[] = [];
    // Newest first.
    const rows = this.readAll().reverse();
    for (const row of rows) {
      if (
        row.summary.toLowerCase().includes(lower) ||
        row.tags.toLowerCase().includes(lower)
      ) {
        results.push(row);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  list(limit = 20): SessionSummaryRow[] {
    const rows = this.readAll();
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows.slice(0, limit);
  }
}
