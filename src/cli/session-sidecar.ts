/**
 * Session sidecar — a tiny JSON file persisting a long-lived worker's latest
 * engine (SDK) session id, so a freshly-spawned worker can resume the prior
 * conversation across *process* boundaries (ACP `session/load` live resume).
 *
 * In-process, a long-lived worker resumes via `engine.getSessionId()` across
 * `run_more` turns (B0.5). Cross-process, that in-memory id is gone — the
 * sidecar carries it: the worker writes its session id here after each turn and,
 * on its first turn (when there is no in-memory id), reads it back to resume.
 *
 * The path is supplied per-spawn (only the coordinator root gets one, threaded
 * from the ACP layer); the worker just reads/writes the given file. Best-effort:
 * a broken read/write degrades to a fresh conversation, never crashes the turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Read the persisted session id, or undefined if absent/unreadable/malformed. */
export function readSessionSidecar(file: string): string | undefined {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8")) as {
      sessionId?: unknown;
    };
    return typeof obj.sessionId === "string" && obj.sessionId.length > 0
      ? obj.sessionId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the latest session id (best-effort; creates the parent dir). */
export function writeSessionSidecar(file: string, sessionId: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId }) + "\n");
  } catch {
    // best effort — losing the sidecar only forfeits cross-process resume
  }
}
