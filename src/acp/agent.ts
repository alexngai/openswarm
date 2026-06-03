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
import type { AgentEngine, RunConfig } from "../engine/index.js";
import { makeCanUseTool } from "../permissions/gate.js";
import { initializeResponse } from "./capabilities.js";
import { makeAcpTranslator } from "./translator.js";
import { AcpPermissionBridge } from "./permission.js";
import { promptToText } from "./content.js";

interface AcpSession {
  readonly engine: AgentEngine;
  /** Reset to a fresh controller at the start of each prompt turn. */
  abort: AbortController;
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

    // Fresh abort controller per turn so a prior cancel doesn't poison this one.
    const abort = new AbortController();
    session.abort = abort;

    const bridge = new AcpPermissionBridge(this.conn, req.sessionId);
    const canUseTool = makeCanUseTool({
      dispatcher: this.rt.dispatcher,
      permEngine: this.rt.permEngine,
      bridge,
      // Route mode-deny + bash-Warn prompts through the ACP client, not stdin.
      useHeadless: false,
      getCurrentMode: () => this.opts.permissionMode,
      cwd: session.cwd,
    });

    const translator = makeAcpTranslator(this.conn, req.sessionId);
    const config: RunConfig = {
      systemPrompt: "",
      prompt: promptToText(req.prompt),
      model: this.rt.resolvedModelId,
      auth: this.rt.auth,
      tools: this.rt.tools,
      canUseTool,
      permissionMode: this.opts.permissionMode,
      hooks: this.rt.hooksConfig,
      abort: abort.signal,
    };

    try {
      for await (const ev of session.engine.run(config)) {
        await translator.emit(ev);
      }
    } catch (err) {
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw err;
    }

    if (abort.signal.aborted) return { stopReason: "cancelled" };
    return { stopReason: translator.stopReason() };
  }

  async cancel(req: CancelNotification): Promise<void> {
    this.sessions.get(req.sessionId)?.abort.abort();
  }
}
