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
  readonly event: NormalizedEvent;
}

export interface ScriptedTestEngineOptions {
  /** Path to a JSON file containing ScriptedEvent[]. If unset, reads
   *  SWARM_CODER_TEST_SCRIPT env. */
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

  constructor(opts: ScriptedTestEngineOptions = {}) {
    if (opts.script) {
      this.script = opts.script;
    } else {
      const path = opts.scriptPath ?? process.env.SWARM_CODER_TEST_SCRIPT;
      if (!path) {
        throw new Error(
          "ScriptedTestEngine: no script provided (opts.script or SWARM_CODER_TEST_SCRIPT)",
        );
      }
      const raw = fs.readFileSync(path, "utf8");
      this.script = JSON.parse(raw) as ScriptedEvent[];
    }
  }

  getCumulativeUsage(): Usage {
    return this._cumulativeUsage;
  }

  async *run(_config: RunConfig): AsyncIterable<NormalizedEvent> {
    for (const entry of this.script) {
      if (entry.delayMs && entry.delayMs > 0) {
        await new Promise((r) => setTimeout(r, entry.delayMs));
      }
      const event = entry.event;
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
