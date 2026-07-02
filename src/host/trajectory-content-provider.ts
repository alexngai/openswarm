/**
 * trajectory-content-provider.ts — Layer 2. Serve a recorded session's content
 * on demand when a hub requests it for a trajectory checkpoint we reported
 * (Layer 1). Mirrors claude-code-swarm's content-provider.mjs.
 *
 * The checkpoint id IS the worker session id (Layer 1 sets `checkpoint.id =
 * sessionId`), so we resolve `<sessionsDir>/<checkpointId>/events.jsonl` — the
 * transcript the recorder wrote (Layer 0a) — and return it as named artifacts
 * (`transcript`, `prompts`, `metadata`, `context`), the inline content-result
 * shape MAP's trajectory extension expects.
 *
 * Pure filesystem + best-effort: returns null when the session isn't found.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSessionsDir } from "../swarm/session-recorder.js";

/** Inline trajectory content result (MAP `TrajectoryContentResultInline`). */
export interface TrajectoryContent {
  readonly checkpointId: string;
  readonly streaming: false;
  readonly artifacts: {
    readonly transcript: string;
    readonly prompts: string;
    readonly metadata: Record<string, unknown>;
    readonly context: string;
  };
}

interface LaneRecord {
  type: string;
  payload?: { prompt?: unknown; text?: unknown };
}

function parse(text: string): LaneRecord[] {
  const out: LaneRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as LaneRecord;
      if (r && typeof r.type === "string") out.push(r);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Resolve the content for a checkpoint (= session id). Returns null when the
 * session transcript can't be found or read.
 */
export function resolveTrajectoryContent(
  checkpointId: string,
  opts?: { cwd?: string },
): TrajectoryContent | null {
  try {
    const cwd = opts?.cwd ?? process.cwd();
    const file = path.join(
      resolveSessionsDir(cwd),
      checkpointId,
      "events.jsonl",
    );
    if (!fs.existsSync(file)) return null;

    const transcript = fs.readFileSync(file, "utf8");
    const events = parse(transcript);
    const prompts = events
      .filter((e) => e.type === "turn_start" && typeof e.payload?.prompt === "string")
      .map((e) => e.payload!.prompt as string)
      .join("\n---\n");
    const turns = events.filter((e) => e.type === "turn_start").length;
    const toolCalls = events.filter((e) => e.type === "tool_use_start").length;

    return {
      checkpointId,
      streaming: false,
      artifacts: {
        transcript,
        prompts,
        metadata: {
          sessionId: checkpointId,
          turns,
          toolCalls,
          source: "openswarm",
        },
        context: `openswarm session ${checkpointId} (${turns} turn(s), ${toolCalls} tool call(s))`,
      },
    };
  } catch {
    return null;
  }
}
