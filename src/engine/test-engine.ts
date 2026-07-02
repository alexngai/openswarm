import * as fs from "node:fs";
import type {
  AgentEngine,
  EngineCapabilities,
  RunConfig,
} from "./index.js";
import type { NormalizedEvent, Usage } from "../core/types.js";

/** One entry in a scripted fixture. */
export interface ScriptedEvent {
  /** Optional delay in ms before emitting this event (default 0). */
  readonly delayMs?: number;
  /** Emit a normalized event. Mutually exclusive with `canUseTool`. */
  readonly event?: NormalizedEvent;
  /**
   * Before continuing, invoke `config.canUseTool(name, input)`. This lets a
   * scripted worker deterministically drive the permission gate — and, on the
   * ACP team path where the worker's gate escalates over IPC, the full
   * orchestrator round-trip — without a live model. The decision is emitted as
   * a `text_delta` ("ALLOWED" or "DENIED:<reason>") so it's observable.
   */
  readonly canUseTool?: { readonly name: string; readonly input?: unknown };
}

export interface ScriptedTestEngineOptions {
  /** Path to a JSON file containing ScriptedEvent[]. If unset, reads
   *  OPENSWARM_TEST_SCRIPT env. */
  readonly scriptPath?: string;
  /** In-memory script, overrides scriptPath if both provided (tests). */
  readonly script?: readonly ScriptedEvent[];
}

export class ScriptedTestEngine implements AgentEngine {
  readonly id = "scripted-test";

  // Match ClaudeAgentSdkEngine capabilities exactly so tool wiring doesn't
  // diverge between real and test paths.
  readonly capabilities: EngineCapabilities = {
    streaming: true,
    promptCache: true,
    parallelToolUse: true,
    mcp: true,
    compaction: true,
    resume: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 64_000,
  };

  private readonly script: readonly ScriptedEvent[];
  private _cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  // Mirrors a real engine: a session id becomes available only once a turn has
  // run. Lets long-lived/cross-process resume paths be exercised deterministically
  // (the worker reads getSessionId() BEFORE each run — undefined on the first).
  private _sessionId: string | undefined;

  constructor(opts: ScriptedTestEngineOptions = {}) {
    if (opts.script) {
      this.script = opts.script;
    } else {
      const path = opts.scriptPath ?? process.env.OPENSWARM_TEST_SCRIPT;
      if (!path) {
        throw new Error(
          "ScriptedTestEngine: no script provided (opts.script or OPENSWARM_TEST_SCRIPT)",
        );
      }
      const raw = fs.readFileSync(path, "utf8");
      this.script = JSON.parse(raw) as ScriptedEvent[];
    }
  }

  getCumulativeUsage(): Usage {
    return this._cumulativeUsage;
  }

  /** Undefined until the first `run`, then a stable id (env-overridable). */
  getSessionId(): string | undefined {
    return this._sessionId;
  }

  async *run(config: RunConfig): AsyncIterable<NormalizedEvent> {
    // A turn establishes the session id (as a real SDK turn would).
    this._sessionId =
      process.env.OPENSWARM_TEST_SESSION_ID ?? "scripted-session";
    // Opt-in resume echo: surface the resumed session id so cross-process
    // resume (B1.4) can be asserted end-to-end. Off by default so normal
    // run_more turns (which carry resumeFrom) keep byte-identical output.
    if (process.env.OPENSWARM_TEST_ECHO_RESUME === "1") {
      const resumed = (
        config.resumeFrom?.data as { sessionId?: string } | undefined
      )?.sessionId;
      if (resumed !== undefined) {
        yield { type: "text_delta", text: `RESUMED:${resumed}` };
      }
    }
    for (const entry of this.script) {
      if (entry.delayMs && entry.delayMs > 0) {
        await new Promise((r) => setTimeout(r, entry.delayMs));
      }
      // A canUseTool directive drives the permission gate and surfaces the
      // decision as text (real engines feed denials back to the model; here we
      // just make the outcome observable to the test).
      if (entry.canUseTool !== undefined) {
        const decision = await config.canUseTool(
          entry.canUseTool.name,
          entry.canUseTool.input ?? {},
        );
        const text = decision.allow
          ? "ALLOWED"
          : `DENIED:${decision.reason ?? ""}`;
        yield { type: "text_delta", text };
        continue;
      }
      const event = entry.event;
      if (event === undefined) continue;
      // Accumulate usage from message_stop events.
      if (event.type === "message_stop") {
        const u = event.usage;
        const prev = this._cumulativeUsage;
        this._cumulativeUsage = {
          inputTokens: prev.inputTokens + u.inputTokens,
          outputTokens: prev.outputTokens + u.outputTokens,
          ...((prev.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) > 0
            ? {
                cacheReadInputTokens:
                  (prev.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0),
              }
            : {}),
          ...((prev.cacheWriteInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0) > 0
            ? {
                cacheWriteInputTokens:
                  (prev.cacheWriteInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0),
              }
            : {}),
        };
      }
      yield event;
    }
  }
}
