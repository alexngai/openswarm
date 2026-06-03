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
} from "@agentclientprotocol/sdk";
import type { CommonOpts } from "../cli/argv.js";
import type { AgentHandle } from "../swarm/host.js";
import type { TeamRunner } from "./team-runner.js";
import { initializeResponse } from "./capabilities.js";
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
  ) {}

  async initialize(req: InitializeRequest): Promise<InitializeResponse> {
    // Team transcript replay (session/load) lands in B1; advertise it off.
    return initializeResponse(req, { loadSession: false });
  }

  async authenticate(
    _req: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      abort: new AbortController(),
      cwd: req.cwd,
    });
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
    });
    const unsubscribe = this.runner.subscribeEvents((e) =>
      translator.onLaneEvent(e),
    );
    // Route this turn's member permission escalations to this session.
    this.router?.setActiveSession(req.sessionId);

    const text = promptToText(req.prompt);
    try {
      let cancelled: boolean;
      if (session.leadHandle === undefined) {
        // First prompt: run the coordinator team (spawns the persistent root).
        const result = await this.runner.runTeam(buildCoordinatorSpec(text));
        // Capture the long-lived root so the next prompt can steer it.
        session.leadHandle = this.findLead();
        cancelled = result.cancelled > 0;
      } else {
        // Subsequent prompt: steer the same root with the new message.
        const result = await session.leadHandle.runMore(text);
        // A cancel mid-turn kills the root -> "killed" status.
        cancelled = result.status === "killed";
      }
      await translator.drain();
      if (abort.signal.aborted || cancelled) {
        return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn" };
    } catch (err) {
      await translator.drain().catch(() => {});
      if (abort.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    } finally {
      unsubscribe();
      this.router?.setActiveSession(undefined);
    }
  }

  async cancel(req: CancelNotification): Promise<void> {
    const session = this.sessions.get(req.sessionId);
    if (session === undefined) return;
    session.abort.abort();
    // Kill the root so the in-flight turn stops. Look it up live (it may not be
    // captured yet during the first turn). The next prompt starts a fresh team.
    session.leadHandle = undefined;
    await this.findLead()?.kill().catch(() => {});
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
