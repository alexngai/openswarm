import * as fs from "node:fs";
import type {
  AgentEngine,
  EngineCapabilities,
  RunConfig,
} from "./index.js";
import type { NormalizedEvent } from "../core/types.js";

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

  async *run(_config: RunConfig): AsyncIterable<NormalizedEvent> {
    for (const entry of this.script) {
      if (entry.delayMs && entry.delayMs > 0) {
        await new Promise((r) => setTimeout(r, entry.delayMs));
      }
      yield entry.event;
    }
  }
}
