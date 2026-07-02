/**
 * Session recorder — writes a worker's lane-event spine to a per-session
 * `events.jsonl` transcript that sessionlog's OpenSwarm agent adapter can
 * read (and cognitive-core can later distill).
 *
 * Layout matches the adapter: `<sessionsDir>/<sessionId>/events.jsonl`, where
 * `sessionsDir` is `OPENSWARM_SESSION_DIR` or, preferring the new swarmkit
 * namespace, `<cwd>/.openswarm/openswarm/sessions` when present, else the
 * legacy `<cwd>/.swarm/openswarm/sessions` (see resolveSessionsDir). sessionlog
 * and opentasks honor both names during the `.swarm` → `.openswarm` migration.
 *
 * Opt-in + best-effort: recording only happens when enabled (a session dir or
 * the record flag is set), and every operation swallows errors so it can never
 * block or crash a worker. Writes the transcript (Layer 0a) and, when sessionlog
 * is enabled in the repo, drives the checkpoint lifecycle (Layer 0b).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LaneEvent } from "./events.js";
import {
  beginCheckpointedSession,
  type CheckpointedSession,
} from "./session-checkpointer.js";

/** Recording is opt-in: a session dir or the explicit flag turns it on. */
export function recordingEnabled(): boolean {
  return (
    process.env.OPENSWARM_RECORD_SESSIONS === "1" ||
    (process.env.OPENSWARM_SESSION_DIR ?? "").length > 0
  );
}

export function resolveSessionsDir(cwd: string): string {
  const override = process.env.OPENSWARM_SESSION_DIR;
  if (override && override.length > 0) return override;
  // Prefer the new swarmkit namespace when a project has migrated; otherwise
  // fall back to (and freshly create) the legacy `.swarm` layout so readers
  // that haven't been updated still find the transcripts. Full cutover to
  // `.openswarm` (flip the default, drop `.swarm`) is a later coordinated step.
  const migrated = path.join(cwd, ".openswarm", "openswarm", "sessions");
  if (fs.existsSync(migrated)) return migrated;
  return path.join(cwd, ".swarm", "openswarm", "sessions");
}

export interface SessionRecorder {
  /** Append a lane event to the transcript (best-effort). */
  record(event: LaneEvent): void;
  /** Flush and close the transcript. */
  close(): Promise<void>;
  /** Absolute path of the events.jsonl transcript. */
  readonly transcriptPath: string;
  /** The session identifier this recorder is writing under. */
  readonly sessionId: string;
}

export interface SessionRecorderOptions {
  readonly sessionId: string;
  readonly agentId: string;
  /** The task prompt — recorded as the first `turn_start` so it is distillable. */
  readonly prompt: string;
  readonly cwd?: string;
}

/**
 * Begin recording a session transcript (and, when sessionlog is enabled, open a
 * checkpoint session). Returns `null` when recording is disabled or cannot be
 * set up — callers use `recorder?.record(...)` / `await recorder?.close()`.
 */
export async function startSessionRecorder(
  opts: SessionRecorderOptions,
): Promise<SessionRecorder | null> {
  if (!recordingEnabled()) return null;
  try {
    const cwd = opts.cwd ?? process.cwd();
    const dir = path.join(resolveSessionsDir(cwd), opts.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const transcriptPath = path.join(dir, "events.jsonl");
    const stream = fs.createWriteStream(transcriptPath, { flags: "w" });

    const writeLine = (obj: unknown): void => {
      try {
        stream.write(JSON.stringify(obj) + "\n");
      } catch {
        // transcript write failed — drop silently, never block the worker
      }
    };

    // Record the task prompt as turn_start so the adapter's extractPrompts works.
    writeLine({
      ts: Date.now(),
      agentId: opts.agentId,
      type: "turn_start",
      payload: { prompt: opts.prompt },
    });

    // Open a sessionlog checkpoint session (SessionStart + TurnStart) now, so
    // the turn window captures the work that follows. No-ops unless sessionlog
    // is enabled in this repo.
    const checkpoint: CheckpointedSession | null =
      await beginCheckpointedSession({
        sessionId: opts.sessionId,
        sessionRef: transcriptPath,
        prompt: opts.prompt,
        cwd,
      });

    return {
      transcriptPath,
      sessionId: opts.sessionId,
      record(event: LaneEvent): void {
        writeLine(event);
      },
      close(): Promise<void> {
        return new Promise((resolve) => {
          // Flush the transcript, then finish the checkpoint (TurnEnd ->
          // SessionEnd). Best-effort: a failed checkpoint never blocks close.
          const finalize = (): void => {
            void Promise.resolve(checkpoint?.finish()).then(
              () => resolve(),
              () => resolve(),
            );
          };
          try {
            stream.end(finalize);
          } catch {
            finalize();
          }
        });
      },
    };
  } catch {
    return null;
  }
}
