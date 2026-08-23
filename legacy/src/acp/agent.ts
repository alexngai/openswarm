/**
 * AcpAgent — implements the ACP SDK `Agent` interface for OpenSwarm
 * (single-agent mode; team mode lives in team-agent.ts).
 *
 * Owns session lifecycle + initialize, runs the prompt turn through the
 * engine→session/update translator, and trips the
 * per-session AbortController on cancel.
 *
 * The `conn` (AgentSideConnection) is the client-facing handle —
 * `conn.sessionUpdate(...)` / `conn.requestPermission(...)` go through it.
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
import { SessionAllowRules } from "../permissions/session-rules.js";
import { SessionStore } from "../session/store.js";
import { initializeResponse } from "./capabilities.js";
import { makeAcpTranslator } from "./translator.js";
import { AcpPermissionBridge } from "./permission.js";
import { promptToText } from "./content.js";
import { historyChunks } from "./history.js";
import {
  enrichTurnInputs,
  observeTurnEvents,
  endMemorySession,
  type TurnRecord,
} from "../memory/index.js";

interface AcpSession {
  readonly engine: AgentEngine;
  /** Reset to a fresh controller at the start of each prompt turn. */
  abort: AbortController;
  readonly cwd: string;
  /** Session-scoped bash "always allow" rules (Phase 3 B4); spans turns. */
  readonly sessionRules: SessionAllowRules;
  /** Phase 3 B1 — per-turn memory records; archived on process exit. */
  readonly memoryTurns: TurnRecord[];
  /** Set by session/load; applied once on the next prompt, then cleared. */
  resumeFrom?: SessionSnapshot;
}

export class AcpAgent implements Agent {
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly rt: AgentRuntime,
    private readonly opts: CommonOpts,
  ) {
    // Phase 3 B1/B2 (decision Q2) — ACP sessions never formally close (the
    // client just drops the process), so `beforeExit` is the catch-all
    // session-end point. Best-effort fire-and-forget; endMemorySession
    // carries its own hard timeout.
    process.once("beforeExit", () => {
      for (const [sessionId, session] of this.sessions) {
        void endMemorySession({
          sessionId,
          turns: session.memoryTurns,
        }).catch(() => {});
      }
    });
  }

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
      sessionRules: new SessionAllowRules(),
      memoryTurns: [],
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
      sessionRules: new SessionAllowRules(),
      memoryTurns: [],
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
      sessionRules: session.sessionRules,
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
      // Phase 3 B1 — the observer fires onAfterTurn / onCompaction and
      // records this turn for the beforeExit session archive.
      const observed = observeTurnEvents(session.engine.run(runConfig), {
        sessionId: req.sessionId,
        turnIndex: session.memoryTurns.length,
        onRecord: (record) => session.memoryTurns.push(record),
      });
      for await (const ev of observed) {
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
