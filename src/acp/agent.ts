/**
 * AcpAgent — implements the ACP SDK `Agent` interface for swarm-harness.
 *
 * Stage A Steps 1–2: session lifecycle + initialize. The prompt turn is a
 * clean no-op until Step 3 wires the engine→session/update translator
 * (docs/32 §6, §9); cancel already trips the per-session AbortController so the
 * Step-3 implementation inherits correct cancellation.
 *
 * The `conn` (AgentSideConnection) is the client-facing handle — Step 3 calls
 * `conn.sessionUpdate(...)` / `conn.requestPermission(...)` through it.
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
import type { AgentRuntime } from "../cli/runtime.js";
import type { CommonOpts } from "../cli/argv.js";
import type { AgentEngine } from "../engine/index.js";
import { initializeResponse } from "./capabilities.js";

interface AcpSession {
  readonly engine: AgentEngine;
  readonly abort: AbortController;
  readonly cwd: string;
}

export class AcpAgent implements Agent {
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly rt: AgentRuntime,
    private readonly opts: CommonOpts,
  ) {}

  async initialize(req: InitializeRequest): Promise<InitializeResponse> {
    return initializeResponse(req);
  }

  async authenticate(
    _req: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    // No interactive auth method is advertised: the process inherits env /
    // keychain auth, already validated by buildAgentRuntime. Nothing to do.
    return {};
  }

  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const { engine } = await this.rt.makeEngine(sessionId);
    this.sessions.set(sessionId, {
      engine,
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
    // TODO(Step 3): build a RunConfig from `req.prompt`, drive
    // `session.engine.run(config)`, and translate each NormalizedEvent into a
    // `conn.sessionUpdate(...)` notification; resolve the mapped stopReason.
    // For Steps 1–2 the turn ends cleanly without producing output.
    return { stopReason: "end_turn" };
  }

  async cancel(req: CancelNotification): Promise<void> {
    this.sessions.get(req.sessionId)?.abort.abort();
  }
}
