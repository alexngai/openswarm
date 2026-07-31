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
import { openTranscript } from "./transcript-writer.js";
import {
  beginCheckpointedSession,
  type CheckpointedSession,
  type UsedSkill,
} from "./session-checkpointer.js";

// ---------------------------------------------------------------------------
// Skill-use tracking (SkillUse declaration — the *applied* attribution leg)
// ---------------------------------------------------------------------------

const MAX_TRACKED_SKILL_USES = 100;

/** Skill-loading tools across engines: openswarm's tier-1 `skill` tool
 *  (input `{id}`) and Claude Code's native `Skill` tool via the
 *  claude-agent-sdk engine (input `{skill, args}` — the shape sessionlog's
 *  own claude-code hook parses). Matched case-insensitively. */
function isSkillTool(toolName: string | undefined): boolean {
  return toolName !== undefined && toolName.toLowerCase() === "skill";
}

/**
 * Observes the lane-event stream for explicit skill tool invocations so
 * they can be declared to sessionlog as SkillUse events at close (sessionlog
 * `skillsUsed` → cognitive-core `appliedPlaybookIds`). Reassembles streamed
 * tool input (tool_use_input jsonDelta) per tool-use id, and drops
 * invocations whose tool_result reported an error (a failed load is not an
 * application). Payload key variants are handled for both the NormalizedEvent
 * spread (`id`/`name`/`jsonDelta`) and typed lane payloads
 * (`toolUseId`/`toolName`/`partialJson`).
 */
export class SkillUseTracker {
  private readonly pendingInput = new Map<string, string>();
  private readonly candidates = new Map<string, UsedSkill>();
  private readonly errored = new Set<string>();

  observe(event: LaneEvent): void {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const toolUseId = str(p.toolUseId) ?? str(p.id);
    if (toolUseId === undefined) return;

    switch (event.type) {
      case "tool_use_start": {
        if (!isSkillTool(str(p.toolName) ?? str(p.name))) return;
        if (this.candidates.size >= MAX_TRACKED_SKILL_USES) return;
        this.pendingInput.set(toolUseId, "");
        // Some engines carry the full input on start already.
        this.tryFinalize(toolUseId, p.toolInput ?? p.input);
        return;
      }
      case "tool_use_input": {
        if (!this.pendingInput.has(toolUseId)) return;
        const delta = str(p.jsonDelta) ?? str(p.partialJson) ?? "";
        this.pendingInput.set(toolUseId, this.pendingInput.get(toolUseId)! + delta);
        return;
      }
      case "tool_use_end": {
        if (!this.pendingInput.has(toolUseId)) return;
        if (p.input !== undefined) {
          this.tryFinalize(toolUseId, p.input);
        } else {
          const raw = this.pendingInput.get(toolUseId)!;
          try {
            this.tryFinalize(toolUseId, JSON.parse(raw));
          } catch {
            this.pendingInput.delete(toolUseId);
          }
        }
        return;
      }
      case "tool_result": {
        if (p.isError === true) {
          this.errored.add(toolUseId);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Successfully-invoked skills, in invocation order. */
  used(): UsedSkill[] {
    const result: UsedSkill[] = [];
    for (const [toolUseId, skill] of this.candidates) {
      if (!this.errored.has(toolUseId)) result.push(skill);
    }
    return result;
  }

  private tryFinalize(toolUseId: string, input: unknown): void {
    if (typeof input !== "object" || input === null) return;
    const obj = input as Record<string, unknown>;
    // openswarm `skill` tool: {id}; Claude Code `Skill` tool: {skill, args}.
    const name = str(obj.id) ?? str(obj.skill);
    if (name === undefined || name.length === 0) return;
    const args = str(obj.args);
    this.candidates.set(toolUseId, { name, ...(args !== undefined && { args }) });
    this.pendingInput.delete(toolUseId);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

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
  /**
   * Skills injected into this turn's context — declared to sessionlog as
   * SkillsSurfaced so downstream learning (cognitive-core) attributes the
   * guidance instead of counting the session as unguided.
   */
  readonly surfacedSkills?: readonly {
    id: string;
    name: string;
    sourceType?: string;
  }[];
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
    // Appends, one whole line at a time, flushed to disk in batches. Opening
    // for write truncated the session on every reopen; see transcript-writer.ts.
    const transcript = await openTranscript(transcriptPath);
    if (transcript === null) return null;

    const writeLine = (obj: unknown): void => {
      transcript.record(obj);
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
        ...(opts.surfacedSkills !== undefined && {
          surfacedSkills: opts.surfacedSkills,
        }),
      });

    // Track explicit `skill` tool invocations as events stream through, so
    // close() can declare them to sessionlog as SkillUse (applied attribution).
    const skillUses = new SkillUseTracker();

    return {
      transcriptPath,
      sessionId: opts.sessionId,
      record(event: LaneEvent): void {
        writeLine(event);
        try {
          skillUses.observe(event);
        } catch {
          // tracking is additive — never interfere with recording
        }
      },
      async close(): Promise<void> {
        // Get the transcript on disk first, then finish the checkpoint (TurnEnd
        // -> SessionEnd). Best-effort: a failed checkpoint never blocks close.
        await transcript.close().catch(() => {});
        const skillsUsed = skillUses.used();
        await Promise.resolve(
          checkpoint?.finish(skillsUsed.length > 0 ? { skillsUsed } : undefined),
        ).catch(() => {});
      },
    };
  } catch {
    return null;
  }
}
