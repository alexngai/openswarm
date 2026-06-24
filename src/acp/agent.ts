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
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import type { AgentRuntime } from "../cli/runtime.js";
import type { CommonOpts } from "../cli/argv.js";
import type {
  AgentEngine,
  RunConfig,
  SessionSnapshot,
} from "../engine/index.js";
import { makeCanUseTool } from "../permissions/gate.js";
import { SessionStore } from "../session/store.js";
import { initializeResponse } from "./capabilities.js";
import { makeAcpTranslator } from "./translator.js";
import { AcpPermissionBridge } from "./permission.js";
import { promptToText } from "./content.js";
import { historyChunks } from "./history.js";
import { enrichTurnInputs } from "../memory/index.js";

interface AcpSession {
  readonly engine: AgentEngine;
  /** Reset to a fresh controller at the start of each prompt turn. */
  abort: AbortController;
  readonly cwd: string;
  /** Set by session/load; applied once on the next prompt, then cleared. */
  resumeFrom?: SessionSnapshot;
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

  async loadSession(req: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Replay prior conversation (best-effort) before the session is usable.
    // SDK-engine history lives in the Claude Agent SDK's transcript store;
    // text is streamed back in chronological order (docs/31 Q4).
    const store = new SessionStore();
    const history = await store.readMessages(req.sessionId, req.cwd);
    for (const note of historyChunks(history, req.sessionId)) {
      await this.conn.sessionUpdate(note);
    }

    // Bind the engine and arrange a resume on the next prompt so the
    // conversation continues with its prior context.
    const { engine } = await this.rt.makeEngine(req.sessionId);
    this.sessions.set(req.sessionId, {
      engine,
      abort: new AbortController(),
      cwd: req.cwd,
      resumeFrom: store.buildSnapshot(req.sessionId),
    });
    return {};
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
      // Resume applies once (set by session/load); clear after consuming.
      ...(session.resumeFrom !== undefined
        ? { resumeFrom: session.resumeFrom }
        : {}),
    };
    session.resumeFrom = undefined;

    // Surface memory (minimem + skills) into this ACP turn via the shared seam.
    const enriched = await enrichTurnInputs(config.systemPrompt, config.prompt, {
      query: config.prompt,
      sessionId: req.sessionId,
    });
    const runConfig: RunConfig = {
      ...config,
      systemPrompt: enriched.systemPrompt,
      prompt: enriched.prompt,
    };

    try {
      for await (const ev of session.engine.run(runConfig)) {
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
