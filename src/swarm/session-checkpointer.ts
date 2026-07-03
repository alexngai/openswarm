/**
 * Session checkpointer — Layer 0 part B.
 *
 * Drives sessionlog's lifecycle handler programmatically so a recorded
 * `events.jsonl` transcript becomes a sessionlog checkpoint (the form
 * cognitive-core distills). It is two-phase, matching sessionlog's state
 * machine and capturing the turn's work in the right window:
 *   - begin (at record start): SessionStart -> TurnStart  (marks the offset)
 *   - finish (at close):       TurnEnd -> SessionEnd       (TurnEnd checkpoints)
 *
 * Best-effort and fully decoupled: `sessionlog` is dynamically imported, and
 * every failure mode (missing dep in direct binary-package installs, not a git
 * repo, sessionlog disabled, adapter unavailable) resolves to a no-op so it can
 * never block a worker.
 *
 * Note: the stores must be given the worker's repo `cwd` explicitly — the
 * sessionlog CLI passes `undefined` only because its own process.cwd() is the
 * repo, which is not true for an in-process caller.
 */

export interface CheckpointedSession {
  /** Dispatch TurnEnd (the checkpoint) + SessionEnd. Idempotent. */
  finish(opts?: FinishCheckpointOptions): Promise<void>;
}

export interface FinishCheckpointOptions {
  /**
   * Skills the worker explicitly invoked this turn (openswarm's `skill`
   * tool). Declared to sessionlog as SkillUse events — the *applied* leg of
   * skill attribution (sessionlog `skillsUsed` → cognitive-core
   * `appliedPlaybookIds`), stronger evidence than the surfaced-only
   * SkillsSurfaced declaration. Dispatched just before TurnEnd so they land
   * inside the turn window and reach the checkpoint metadata.
   */
  readonly skillsUsed?: readonly UsedSkill[];
}

/** One explicit skill invocation (the `skill` tool). */
export interface UsedSkill {
  readonly name: string;
  readonly args?: string;
}

export interface BeginCheckpointOptions {
  readonly sessionId: string;
  /** Path to the events.jsonl transcript (the adapter's sessionRef). */
  readonly sessionRef: string;
  /** The task prompt — carried on SessionStart for attribution. */
  readonly prompt: string;
  /** The worker's repo working directory sessionlog operates in. */
  readonly cwd: string;
  /**
   * Skills injected into this turn's context (from the memory SkillProvider).
   * Declared to sessionlog via a SkillsSurfaced event so cognitive-core's
   * exposure attribution counts this session as guided (its external-exposure
   * contract maps sessionlog `skillsSurfaced` → surfacedPlaybookIds).
   */
  readonly surfacedSkills?: readonly {
    id: string;
    name: string;
    sourceType?: string;
  }[];
}

interface SessionRepoConfig {
  sessionRepoCwd?: string;
  sessionsDir?: string;
  checkpointsBranch?: string;
}

type SessionlogModule = typeof import("sessionlog") & {
  resolveSessionRepoConfig?: (cwd?: string) => Promise<SessionRepoConfig>;
};

export async function beginCheckpointedSession(
  opts: BeginCheckpointOptions,
): Promise<CheckpointedSession | null> {
  try {
    const sl = (await import("sessionlog")) as SessionlogModule;

    // Respect sessionlog's own enabled config — no-op if it isn't set up here.
    if (!(await sl.isEnabled(opts.cwd))) return null;

    const agent = sl.getAgent("openswarm");
    if (!agent) return null;

    const cfg = typeof sl.resolveSessionRepoConfig === "function"
      ? await sl.resolveSessionRepoConfig(opts.cwd)
      : {};
    const handler = sl.createLifecycleHandler({
      sessionStore: sl.createSessionStore(opts.cwd, cfg.sessionsDir),
      checkpointStore: sl.createCheckpointStore(
        opts.cwd,
        cfg.sessionRepoCwd,
        cfg.checkpointsBranch,
      ),
      cwd: opts.cwd,
    });

    const base = { sessionID: opts.sessionId, sessionRef: opts.sessionRef };
    await handler.dispatch(agent, {
      ...base,
      type: sl.EventType.SessionStart,
      prompt: opts.prompt,
      timestamp: new Date(),
    });
    await handler.dispatch(agent, {
      ...base,
      type: sl.EventType.TurnStart,
      timestamp: new Date(),
    });

    // Declare surfaced skills inside the turn window so they land in the
    // TurnEnd checkpoint's metadata (`skillsSurfaced`). `upstreamSkillId`
    // carries the stable skill id; cognitive-core's exposure attribution
    // matches on both the name and that id. Skipped on sessionlog versions
    // that predate the SkillsSurfaced event (< 0.0.9).
    if (
      opts.surfacedSkills !== undefined &&
      opts.surfacedSkills.length > 0 &&
      sl.EventType.SkillsSurfaced !== undefined
    ) {
      const surfacedAt = new Date().toISOString();
      try {
        await handler.dispatch(agent, {
          ...base,
          type: sl.EventType.SkillsSurfaced,
          timestamp: new Date(),
          skillsSurfaced: opts.surfacedSkills.map((s) => ({
            name: s.name,
            sourceType: s.sourceType ?? "skill-tree",
            upstreamSkillId: s.id,
            surfacedAt,
          })),
        });
      } catch {
        // exposure declaration is additive — never block checkpointing
      }
    }

    let finished = false;
    return {
      async finish(finishOpts?: FinishCheckpointOptions): Promise<void> {
        if (finished) return;
        finished = true;

        // Declare explicit skill invocations before TurnEnd so sessionlog's
        // handleSkillUse records them (`skillsUsed`, with `usedAt`) while the
        // session is still in its turn window. Skipped on sessionlog versions
        // that predate the SkillUse event. One event per invocation —
        // sessionlog appends each to the session's skillsUsed list.
        if (
          finishOpts?.skillsUsed !== undefined &&
          finishOpts.skillsUsed.length > 0 &&
          sl.EventType.SkillUse !== undefined
        ) {
          for (const skill of finishOpts.skillsUsed) {
            if (skill.name.length === 0) continue;
            try {
              await handler.dispatch(agent, {
                ...base,
                type: sl.EventType.SkillUse,
                timestamp: new Date(),
                skillName: skill.name,
                ...(skill.args !== undefined && { skillArgs: skill.args }),
              });
            } catch {
              // application declaration is additive — never block checkpointing
            }
          }
        }

        try {
          await handler.dispatch(agent, {
            ...base,
            type: sl.EventType.TurnEnd,
            timestamp: new Date(),
          });
          await handler.dispatch(agent, {
            ...base,
            type: sl.EventType.SessionEnd,
            timestamp: new Date(),
          });
        } catch {
          // best-effort — a failed checkpoint must never surface to the worker
        }
      },
    };
  } catch {
    // sessionlog unavailable / not a git repo / disabled — best-effort no-op.
    return null;
  }
}
