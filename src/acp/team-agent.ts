/**
 * AcpTeamAgent — a team-mode ACP session bound to a coordinator team (docs/33).
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
import type { AcpPermissionRouter } from "./team-permission.js";

interface TeamSessionRecord {
  abort: AbortController;
  readonly cwd: string;
  /** The long-lived coordinator root, captured after the first turn. */
  leadHandle?: AgentHandle;
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
  ) {}

  /** Baseline member-text policy (Q3), from the client's _meta.swarm cap. */
  private memberText: "collapse" | "interleave" = "collapse";

  async initialize(req: InitializeRequest): Promise<InitializeResponse> {
    // Honor the client's requested member-text mode (default collapse), B1.2.
    const cap = readClientSwarmCapability(req);
    if (cap?.memberText === "interleave") this.memberText = "interleave";
    // Advertise _meta.swarm support (B1.2). Team transcript replay (session/load)
    // lands in B1.4; advertise it off for now.
    return initializeResponse(req, { loadSession: false, swarmMeta: true });
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
    try {
      let stop: StopReason;
      if (session.leadHandle === undefined) {
        // First prompt (or a fresh start after cancel/failure): run the
        // coordinator team. Tear down any prior team first so a cancelled turn
        // can't leak its old root + peers into the new run (R2).
        await this.disposeActiveTeam();
        const result = await this.runner.runTeam(
          buildCoordinatorSpec(text, session.cwd),
          { signal: abort.signal },
        );
        // Capture the long-lived root so the next prompt can steer it.
        session.leadHandle = this.findLead();
        stop = teamResultStop(result);
      } else {
        // Subsequent prompt: steer the same root with the new message.
        let result: Awaited<ReturnType<AgentHandle["runMore"]>>;
        try {
          result = await session.leadHandle.runMore(text);
        } catch {
          // A rejected runMore means the root is likely dead — drop it so the
          // next prompt respawns a fresh team, and report non-success rather
          // than erroring the whole prompt request (B4).
          session.leadHandle = undefined;
          await translator.drain().catch(() => {});
          return { stopReason: abort.signal.aborted ? "cancelled" : "refusal" };
        }
        stop = runMoreStop(result);
        // killed = cancel killed the root; it won't accept the next runMore.
        if (result.status === "killed") session.leadHandle = undefined;
      }
      await translator.drain();
      if (abort.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      return { stopReason: stop };
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

  async cancel(req: CancelNotification): Promise<void> {
    const session = this.sessions.get(req.sessionId);
    if (session === undefined) return;
    session.abort.abort();
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
