import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptedTestEngine } from "./test-engine.js";
import type { ScriptedEvent } from "./test-engine.js";
import type { RunConfig } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): RunConfig {
  return {
    systemPrompt: "",
    prompt: "test",
    model: "claude-sonnet-4-6",
    auth: {
      kind: "api-key" as const,
      providerId: "anthropic",
      isAuthenticated: async () => true,
      headers: async () => ({}),
    },
    tools: [],
    canUseTool: async (_name, _input) => ({ allow: true }),
    permissionMode: "workspace-write",
  };
}

async function collectEvents(engine: ScriptedTestEngine): Promise<object[]> {
  const events: object[] = [];
  for await (const evt of engine.run(makeConfig())) {
    events.push(evt);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Test 1: Loads from opts.script in-memory
// ---------------------------------------------------------------------------

describe("ScriptedTestEngine — in-memory script", () => {
  it("streams events from opts.script in order", async () => {
    const script: readonly ScriptedEvent[] = [
      { event: { type: "text_delta", text: "hello" } },
      {
        event: {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      },
    ];

    const engine = new ScriptedTestEngine({ script });
    const events = await collectEvents(engine);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "hello" });
    expect(events[1]).toMatchObject({ type: "message_stop", stopReason: "end_turn" });
  });

  it("has correct id and capabilities matching ClaudeAgentSdkEngine", () => {
    const engine = new ScriptedTestEngine({
      script: [],
    });
    expect(engine.id).toBe("scripted-test");
    expect(engine.capabilities).toEqual({
      streaming: true,
      promptCache: true,
      parallelToolUse: true,
      mcp: true,
      compaction: true,
      resume: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 64_000,
    });
  });

  it("throws when no script source provided", () => {
    const saved = process.env.SWARM_HARNESS_TEST_SCRIPT;
    delete process.env.SWARM_HARNESS_TEST_SCRIPT;
    expect(() => new ScriptedTestEngine()).toThrow("ScriptedTestEngine");
    if (saved !== undefined) process.env.SWARM_HARNESS_TEST_SCRIPT = saved;
  });
});

// ---------------------------------------------------------------------------
// Test 2: Loads from opts.scriptPath
// ---------------------------------------------------------------------------

describe("ScriptedTestEngine — scriptPath", () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  });

  it("reads and parses a JSON file from scriptPath", async () => {
    const script: ScriptedEvent[] = [
      { event: { type: "text_delta", text: "from-file" } },
      {
        event: {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      },
    ];

    tmpFile = path.join(os.tmpdir(), `test-engine-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(script), "utf8");

    const engine = new ScriptedTestEngine({ scriptPath: tmpFile });
    const events = await collectEvents(engine);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "from-file" });
  });

  it("reads from SWARM_HARNESS_TEST_SCRIPT env when no opts provided", async () => {
    const script: ScriptedEvent[] = [
      { event: { type: "text_delta", text: "from-env" } },
    ];

    tmpFile = path.join(os.tmpdir(), `test-engine-env-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(script), "utf8");

    const saved = process.env.SWARM_HARNESS_TEST_SCRIPT;
    process.env.SWARM_HARNESS_TEST_SCRIPT = tmpFile;

    try {
      const engine = new ScriptedTestEngine();
      const events = await collectEvents(engine);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "text_delta", text: "from-env" });
    } finally {
      if (saved !== undefined) {
        process.env.SWARM_HARNESS_TEST_SCRIPT = saved;
      } else {
        delete process.env.SWARM_HARNESS_TEST_SCRIPT;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Events emitted in order with delayMs honored
// ---------------------------------------------------------------------------

describe("ScriptedTestEngine — delayMs", () => {
  it("emits events in order with delayMs delays (real timers)", async () => {
    const script: readonly ScriptedEvent[] = [
      { delayMs: 10, event: { type: "text_delta", text: "first" } },
      { delayMs: 10, event: { type: "text_delta", text: "second" } },
      {
        event: {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 2, outputTokens: 2 },
        },
      },
    ];

    const engine = new ScriptedTestEngine({ script });
    const timestamps: number[] = [];
    const texts: string[] = [];

    for await (const evt of engine.run(makeConfig())) {
      timestamps.push(Date.now());
      if (evt.type === "text_delta") {
        texts.push(evt.text);
      }
    }

    // Events arrive in script order.
    expect(texts).toEqual(["first", "second"]);
    // Each delayed event took at least some time (≥5ms tolerance).
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(5);
  }, 10_000);

  it("emits zero-delay events without waiting", async () => {
    const script: readonly ScriptedEvent[] = [
      { event: { type: "text_delta", text: "a" } },
      { event: { type: "text_delta", text: "b" } },
    ];

    const engine = new ScriptedTestEngine({ script });
    const start = Date.now();
    const events = await collectEvents(engine);
    const elapsed = Date.now() - start;

    expect(events).toHaveLength(2);
    // No delays — should complete in well under 100ms.
    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Test 4: getCumulativeUsage accumulates across runs
// ---------------------------------------------------------------------------

describe("ScriptedTestEngine — getCumulativeUsage", () => {
  it("returns zero usage before any runs", () => {
    const engine = new ScriptedTestEngine({ script: [] });
    expect(engine.getCumulativeUsage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("accumulates usage from message_stop events across two runs", async () => {
    const makeStop = (input: number, output: number): ScriptedEvent => ({
      event: {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: input, outputTokens: output },
      },
    });

    const engine = new ScriptedTestEngine({
      script: [makeStop(100, 50), makeStop(200, 75)],
    });

    // First run — consume both stops.
    await collectEvents(engine);

    const usage = engine.getCumulativeUsage();
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(125);
  });

  it("accumulates cache tokens when present", async () => {
    const engine = new ScriptedTestEngine({
      script: [
        {
          event: {
            type: "message_stop",
            stopReason: "end_turn",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 20,
              cacheWriteInputTokens: 8,
            },
          },
        },
        {
          event: {
            type: "message_stop",
            stopReason: "end_turn",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 30,
              cacheWriteInputTokens: 4,
            },
          },
        },
      ],
    });

    await collectEvents(engine);

    const usage = engine.getCumulativeUsage();
    expect(usage.inputTokens).toBe(20);
    expect(usage.outputTokens).toBe(10);
    expect(usage.cacheReadInputTokens).toBe(50);
    expect(usage.cacheWriteInputTokens).toBe(12);
  });
});
