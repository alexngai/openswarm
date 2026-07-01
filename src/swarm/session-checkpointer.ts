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
  finish(): Promise<void>;
}

export interface BeginCheckpointOptions {
  readonly sessionId: string;
  /** Path to the events.jsonl transcript (the adapter's sessionRef). */
  readonly sessionRef: string;
  /** The task prompt — carried on SessionStart for attribution. */
  readonly prompt: string;
  /** The worker's repo working directory sessionlog operates in. */
  readonly cwd: string;
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

    let finished = false;
    return {
      async finish(): Promise<void> {
        if (finished) return;
        finished = true;
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
