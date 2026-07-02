/**
 * AcpTeamAgent — a team-mode ACP session bound to a coordinator team (docs/archive/33).
 *
 * The first prompt runs the coordinator team, spawning a long-lived root that
 * persists (B0.5: the coordinator honors `persistent`). Subsequent prompts steer
 * that same root via `runMore`, so the conversation continues with context
 * rather than respawning a fresh team each turn. `cancel` kills the root (the
 * next prompt then starts a fresh team). Member work streams through the
 * collapsed lane translator; member permission escalations route to the client.
 */

import * as crypto from "node:crypto";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { CommonOpts } from "../cli/argv.js";
import type { AgentHandle } from "../swarm/host.js";
import type { TeamRunner } from "./team-runner.js";
import { initializeResponse, readClientSwarmCapability } from "./capabilities.js";
import { buildCoordinatorSpec } from "./team-config.js";
import { promptToText } from "./content.js";
import { makeLaneTranslator } from "./lane-translator.js";
import { readSpine, acpSidecarPath } from "./spine.js";
import { replayTeamSpine, findLeadAgentId, mergeLeadProse } from "./team-history.js";
import { readSessionSidecar } from "../cli/session-sidecar.js";
import { SessionStore } from "../session/store.js";
import type { LaneEvent } from "../swarm/events.js";
import type { AcpPermissionRouter } from "./team-permission.js";

/** Reads a prior lead session's assistant narration, in order, for prose replay. */
export type LeadProseReader = (
  leadSessionId: string,
  cwd: string,
) => Promise<readonly string[]>;

/** Default prose reader: the lead worker's SDK session JSONL (assistant text). */
const defaultReadLeadProse: LeadProseReader = async (leadSessionId, cwd) => {
  const msgs = await new SessionStore().readMessages(leadSessionId, cwd);
  return msgs.filter((m) => m.role === "assistant").map((m) => m.text);
};

interface TeamSessionRecord {
  abort: AbortController;
  readonly cwd: string;
  /** Where the root persists its engine session id (B1.4 cross-process resume). */
  readonly sidecarPath: string;
  /** The long-lived coordinator root, captured after the first turn. */
  leadHandle?: AgentHandle;
  /**
   * A turn that parked on a member's open-ended question (Q1). The team is still
   * blocked on the ask; the next prompt answers it and awaits this same run.
   */
  pendingRun?: Promise<StopReason>;
}

export class AcpTeamAgent implements Agent {
  private readonly sessions = new Map<string, TeamSessionRecord>();

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly runner: TeamRunner,
    private readonly opts: CommonOpts,
    private readonly router?: AcpPermissionRouter,
    /** Called once the (single) session is created, with its id. Used to start
     *  the orchestration-spine recorder (B1.3); the caller owns its lifecycle. */
    private readonly onSessionStart?: (sessionId: string) => void,
    /** Reads the lead's prior narration for prose replay (default: SDK JSONL). */
    private readonly readLeadProse: LeadProseReader = defaultReadLeadProse,
  ) {}

  /** Baseline member-text policy (Q3), from the client's _meta.swarm cap. */
  private memberText: "collapse" | "interleave" = "collapse";

  async initialize(req: InitializeRequest): Promise<InitializeResponse> {
    // Honor the client's requested member-text mode (default collapse), B1.2.
    const cap = readClientSwarmCapability(req);
    if (cap?.memberText === "interleave") this.memberText = "interleave";
    // Advertise _meta.swarm support (B1.2) + team transcript replay (B1.4).
    return initializeResponse(req, { loadSession: true, swarmMeta: true });
  }

  async authenticate(
    _req: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    // B0 binds the whole connection to ONE coordinator team: a single shared
    // active team, one permission router, one lead. A second session would
    // collide on all three (steering the same root, racing permission routing),
    // so reject it rather than silently misbehave (R1). A separate team needs a
    // separate connection.
    if (this.sessions.size > 0) {
      throw new Error(
        "team mode supports a single session per connection (B0); " +
          "the coordinator team is shared. Open a new connection for another team.",
      );
    }
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      abort: new AbortController(),
      cwd: req.cwd,
      sidecarPath: acpSidecarPath(sessionId),
    });
    // Bind the permission router to this (single) session for the connection's
    // lifetime. Binding once — rather than per-prompt — means a peer that
    // outlives the prompt that spawned it (root-only quiescence) can still
    // escalate to the client instead of being auto-denied between turns.
    this.router?.setActiveSession(sessionId);
    // Start persisting the orchestration spine for this session (B1.3) so it can
    // be replayed via session/load (B1.4).
    this.onSessionStart?.(sessionId);
    return { sessionId };
  }

  /**
   * session/load (B1.4) — replay a prior team session in wall-clock order, then
   * register the session so the client can continue it (with live engine
   * context-resume via the lead sidecar).
   *
   * The replay re-projects the orchestration spine (B1.3) — `[role]`-attributed
   * tool calls/results + the plan board — and weaves the lead's prior narration
   * back in from its SDK session JSONL (prose replay). Remaining coarseness: tool
   * *arguments* (live-only `tool_use_input`) aren't persisted, so replayed tool
   * calls show names/results without args.
   */
  async loadSession(req: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Same single-session binding as newSession (R1).
    if (this.sessions.size > 0) {
      throw new Error(
        "team mode supports a single session per connection (B0); " +
          "the coordinator team is shared. Open a new connection for another team.",
      );
    }
    // Re-project the persisted spine (+ woven prose) onto session/update.
    const events = await this.buildReplayEvents(req.sessionId, req.cwd);
    await replayTeamSpine(this.conn, req.sessionId, events, this.memberText);
    // Register the session so subsequent prompts continue it. The root spawns
    // with the same sidecar path; since it already holds the prior session's id
    // (persisted in the earlier process), the worker resumes that engine session
    // on its first turn — live context-resume across processes (B1.4).
    this.sessions.set(req.sessionId, {
      abort: new AbortController(),
      cwd: req.cwd,
      sidecarPath: acpSidecarPath(req.sessionId),
    });
    this.router?.setActiveSession(req.sessionId);
    // Resume appending to the same spine for the continued session.
    this.onSessionStart?.(req.sessionId);
    return {};
  }

  /** The spine for a session, with the lead's prior narration woven in (B1.4). */
  private async buildReplayEvents(
    sessionId: string,
    cwd: string,
  ): Promise<readonly LaneEvent[]> {
    const spine = readSpine(sessionId);
    const leadId = findLeadAgentId(spine);
    const leadSessionId = readSessionSidecar(acpSidecarPath(sessionId));
    if (leadId === undefined || leadSessionId === undefined) return spine;
    let prose: readonly string[] = [];
    try {
      prose = await this.readLeadProse(leadSessionId, cwd);
    } catch {
      prose = []; // best-effort — fall back to spine-only replay
    }
    return prose.length > 0 ? mergeLeadProse(spine, leadId, prose) : spine;
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(req.sessionId);
    if (session === undefined) {
      return { stopReason: "refusal" };
    }
    const abort = new AbortController();
    session.abort = abort;

    // Stream the team's lane events to the client (collapsed): the lead
    // narrates, member tool calls surface `[role]`-attributed, and the roster
    // drives a live plan board.
    const translator = makeLaneTranslator(this.conn, req.sessionId, {
      getRoster: () => this.runner.getActiveTeam()?.members,
      memberText: this.memberText,
    });
    const unsubscribe = this.runner.subscribeEvents((e) =>
      translator.onLaneEvent(e),
    );
    // The router is bound to this session at newSession (connection lifetime),
    // so member permission escalations route to the client across turns.

    const text = promptToText(req.prompt);

    // One turn's work, normalized to a StopReason. Side effects (dispose,
    // leadHandle capture, killed→drop) happen as the run progresses.
    const runTurn = async (): Promise<StopReason> => {
      if (session.leadHandle === undefined) {
        // First prompt (or a fresh start after cancel/failure): run the
        // coordinator team. Tear down any prior team first so a cancelled turn
        // can't leak its old root + peers into the new run (R2).
        await this.disposeActiveTeam();
        const result = await this.runner.runTeam(
          buildCoordinatorSpec(text, session.cwd, session.sidecarPath),
          { signal: abort.signal },
        );
        session.leadHandle = this.findLead();
        return teamResultStop(result);
      }
      // Subsequent prompt: steer the same root with the new message.
      let result: Awaited<ReturnType<AgentHandle["runMore"]>>;
      try {
        result = await session.leadHandle.runMore(text);
      } catch {
        // A rejected runMore means the root is likely dead — drop it so the next
        // prompt respawns; report non-success rather than erroring (B4).
        session.leadHandle = undefined;
        return abort.signal.aborted ? "cancelled" : "refusal";
      }
      if (result.status === "killed") session.leadHandle = undefined;
      return runMoreStop(result);
    };

    try {
      // If a prior turn parked on a member's question, this prompt's text is the
      // answer: resolve the ask and resume the SAME run (Q1). Otherwise start a
      // fresh turn.
      let runPromise: Promise<StopReason>;
      if (session.pendingRun !== undefined) {
        this.router?.answerParkedQuestion(text);
        runPromise = session.pendingRun;
        session.pendingRun = undefined;
      } else {
        runPromise = runTurn();
      }

      // Race the turn against a member parking an open-ended question. When a
      // question parks, the team is blocked on the synchronous ask — end this
      // turn coherently (the question was narrated) and stash the run for the
      // next prompt to answer.
      const parkSignal = this.router?.whenParked() ?? new Promise<void>(() => {});
      const outcome = await Promise.race([
        runPromise.then((stop) => ({ parked: false as const, stop })),
        parkSignal.then(() => ({ parked: true as const })),
      ]);

      if (outcome.parked) {
        session.pendingRun = runPromise;
        await translator.drain();
        return { stopReason: "end_turn" };
      }

      // Per-prompt subtree quiescence (Q1): the agent tool blocks by default, so
      // the root already awaited its peers — but a detached `agent({wait:false})`
      // spawn can still be running. Drain those before resolving.
      if (!abort.signal.aborted) await this.drainPeers();
      await translator.drain();
      if (abort.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      return { stopReason: outcome.stop };
    } catch (err) {
      await translator.drain().catch(() => {});
      if (abort.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Custom ACP ext method (B2.0). `swarm/steer` injects a message into the
   * running team's inbox (the lead by default, or a `target` role/member) — the
   * member sees it on its next `check_inbox`, mid-turn, no turn boundary. A
   * baseline client never calls this; rich clients use it instead of
   * cancel+reprompt (docs/31 §7). Returns `{ delivered, to }`.
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "swarm/steer") {
      const message = typeof params.message === "string" ? params.message : "";
      const target =
        typeof params.target === "string" ? params.target : undefined;
      if (message.length === 0) {
        return { delivered: false, error: "steer requires a non-empty message" };
      }
      const res = await this.runner.steer(message, target);
      return { delivered: res.delivered, to: res.to };
    }
    throw new Error(`unknown ext method: ${method}`);
  }

  async cancel(req: CancelNotification): Promise<void> {
    const session = this.sessions.get(req.sessionId);
    if (session === undefined) return;
    session.abort.abort();
    // Release any parked question (Q1) and drop the stashed run so a cancelled
    // turn doesn't leave the team blocked on an ask.
    this.router?.cancelParkedQuestion();
    session.pendingRun = undefined;
    // Tear down the whole team, not just the root: killing only the lead would
    // leak the peers it spawned, and the next prompt would run a fresh root
    // alongside the orphans (R2). The next prompt starts a clean team.
    session.leadHandle = undefined;
    await this.disposeActiveTeam();
  }

  /** Dispose the live team (idempotent, best-effort). */
  private async disposeActiveTeam(): Promise<void> {
    try {
      await this.runner.getActiveTeam()?.dispose();
    } catch {
      // best effort — a half-formed team may already be gone
    }
  }

  /**
   * Await any non-lead members still running (e.g. detached `agent({wait:false})`
   * peers) so the prompt's induced subtree drains before the turn resolves (Q1).
   * The lead is long-lived (its wait() resolved at the first task_result), so we
   * skip it. `wait()` is cached/re-callable and resolves on crash, so already-
   * finished peers return instantly and a dead peer can't hang the drain.
   */
  private async drainPeers(): Promise<void> {
    const members = this.runner.getActiveTeam()?.members;
    if (members === undefined) return;
    const peers = [...members.values()].filter((m) => m.role !== "lead");
    if (peers.length === 0) return;
    await Promise.allSettled(peers.map((p) => p.handle.wait()));
  }

  /** The coordinator root's handle (role "lead", else the first member). */
  private findLead(): AgentHandle | undefined {
    const members = this.runner.getActiveTeam()?.members;
    if (members === undefined) return undefined;
    for (const m of members.values()) {
      if (m.role === "lead") return m.handle;
    }
    return [...members.values()][0]?.handle;
  }
}

/**
 * Map a first-turn TeamResult to an ACP stop reason. ACP has no generic
 * "error" reason, so a non-success turn degrades to "refusal" — the session
 * stays usable and the client sees the turn didn't complete normally.
 */
function teamResultStop(result: {
  readonly cancelled: number;
  readonly failed: number;
  readonly timeout: number;
}): StopReason {
  if (result.cancelled > 0) return "cancelled";
  if (result.failed > 0 || result.timeout > 0) return "refusal";
  return "end_turn";
}

/** Map a steered runMore AgentResult status to an ACP stop reason. */
function runMoreStop(result: { readonly status: string }): StopReason {
  switch (result.status) {
    case "success":
      return "end_turn";
    case "killed":
      return "cancelled";
    default:
      return "refusal"; // failure | timeout
  }
}
