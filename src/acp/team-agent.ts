/**
 * AcpTeamAgent — a team-mode ACP session bound to a coordinator team (docs/33).
 *
 * B0.1 scope: session lifecycle + a prompt that runs the coordinator team to
 * completion under mode-based permissions. The collapsed LaneEvent translator
 * (B0.2), per-member permission routing (B0.3/4), and persistent steering
 * (B0.5) land in later steps; for now the prompt resolves a real team run and
 * surfaces any aggregate output.
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
import type { TeamRunner } from "./team-runner.js";
import { initializeResponse } from "./capabilities.js";
import { buildCoordinatorSpec } from "./team-config.js";
import { promptToText } from "./content.js";
import { makeLaneTranslator } from "./lane-translator.js";
import type { AcpPermissionRouter } from "./team-permission.js";

interface TeamSessionRecord {
  abort: AbortController;
  readonly cwd: string;
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

    try {
      const spec = buildCoordinatorSpec(promptToText(req.prompt));
      const result = await this.runner.runTeam(spec);
      // Flush any notifications still queued behind the async sessionUpdate.
      await translator.drain();
      if (abort.signal.aborted || result.cancelled > 0) {
        return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn" };
    } finally {
      unsubscribe();
      this.router?.setActiveSession(undefined);
    }
  }

  async cancel(req: CancelNotification): Promise<void> {
    // B0.5 wires real run cancellation into the orchestrator; for now mark the
    // session aborted so the prompt resolves as cancelled.
    this.sessions.get(req.sessionId)?.abort.abort();
  }
}
