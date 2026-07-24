/**
 * NativeEngine test suite — ≥ 15 tests.
 *
 * Uses MockProvider (scripted ProviderEvent yields) and MockDispatcher
 * (recorded dispatchBatch calls with scripted results). Neither speaks to
 * the network.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { NativeEngine } from "./native.js";
import { makeSnapshot } from "./native-snapshot.js";
import type { RunConfig, PermissionDecision } from "./index.js";
import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
} from "../providers/index.js";
import type { NormalizedEvent, Usage } from "../core/types.js";
import type {
  ToolDispatcher,
  ToolRequest,
} from "../tools/dispatcher.js";
import type { ToolResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// MockProvider — scripts ProviderEvents per stream() call.
// ---------------------------------------------------------------------------

type Script = readonly ProviderEvent[];

interface MockProviderOpts {
  /** One script per stream() invocation, consumed in order. */
  readonly scripts: readonly Script[];
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** Optional callback invoked with each ProviderRequest. */
  readonly onRequest?: (req: ProviderRequest) => void;
  /** Optional per-event delay (ms) — used for abort-mid-stream tests. */
  readonly delayMs?: number;
}

class MockProvider implements Provider {
  readonly id = "mock";
  readonly model = "mock-model" as never; // LanguageModel type unused by NativeEngine
  readonly capabilities: ProviderCapabilities;

  private readonly scripts: readonly Script[];
  private readonly onRequest?: (req: ProviderRequest) => void;
  private readonly delayMs: number;
  private streamIdx = 0;

  constructor(opts: MockProviderOpts) {
    this.scripts = opts.scripts;
    if (opts.onRequest !== undefined) this.onRequest = opts.onRequest;
    this.delayMs = opts.delayMs ?? 0;
    this.capabilities = {
      streaming: true,
      promptCache: false,
      parallelToolUse: true,
      vision: false,
      reasoning: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 16_000,
      ...opts.capabilities,
    };
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // Deep-copy messages so captures reflect what was sent at this call,
    // not later mutations through the shared array reference (NativeEngine
    // pushes onto its local `messages` array after stream completes).
    if (this.onRequest !== undefined) {
      const snapshot: ProviderRequest = {
        ...req,
        messages: req.messages.map((m) => ({
          ...m,
          content: [...m.content],
        })) as ProviderRequest["messages"],
      };
      this.onRequest(snapshot);
    }
    const script = this.scripts[this.streamIdx];
    this.streamIdx++;
    if (script === undefined) {
      throw new Error(
        `MockProvider: no script for stream() call #${this.streamIdx - 1}`,
      );
    }
    for (const ev of script) {
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
      yield ev;
    }
  }
}

// ---------------------------------------------------------------------------
// MockDispatcher — minimal ToolDispatcher shape NativeEngine exercises.
// ---------------------------------------------------------------------------

interface MockDispatcherOpts {
  /**
   * When set, dispatch() returns these results in order of call.
   * Otherwise echoes input as {"status":"ok", output: JSON.stringify(input)}.
   */
  readonly scriptedResults?: readonly ToolResult[];
  /** When true, dispatch() throws. Used for post-compaction probe failure. */
  readonly dispatchThrows?: boolean;
  /** Capture execution start timestamps for parallelism AC 11. */
  readonly executionTimestamps?: number[];
  /** Artificial per-execution delay. */
  readonly execDelayMs?: number;
}

class MockDispatcher {
  readonly dispatchCalls: Array<{
    name: string;
    input: unknown;
    ctx: { cwd: string };
  }> = [];
  readonly batchCalls: Array<readonly ToolRequest[]> = [];
  private scriptIdx = 0;

  constructor(private readonly opts: MockDispatcherOpts = {}) {}

  async dispatch(
    name: string,
    input: unknown,
    ctx: { cwd: string },
  ): Promise<ToolResult> {
    this.dispatchCalls.push({ name, input, ctx });
    if (this.opts.dispatchThrows === true) {
      throw new Error("mock dispatch failure");
    }
    if (this.opts.scriptedResults !== undefined) {
      const r = this.opts.scriptedResults[this.scriptIdx];
      this.scriptIdx++;
      if (r !== undefined) return r;
    }
    return { status: "ok", output: JSON.stringify(input) };
  }

  async dispatchBatch(
    requests: readonly ToolRequest[],
  ): Promise<readonly ToolResult[]> {
    this.batchCalls.push(requests);
    const results: ToolResult[] = [];
    // Record parallel start timestamps and simulate work.
    const tasks = requests.map(async (req) => {
      if (this.opts.executionTimestamps !== undefined) {
        this.opts.executionTimestamps.push(Date.now());
      }
      if (this.opts.execDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, this.opts.execDelayMs));
      }
      if (this.opts.scriptedResults !== undefined) {
        const idx = this.scriptIdx++;
        const r = this.opts.scriptedResults[idx];
        if (r !== undefined) return r;
      }
      return { status: "ok", output: JSON.stringify(req.input) } as ToolResult;
    });
    const settled = await Promise.all(tasks);
    for (const r of settled) results.push(r);
    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  const c: RunConfig = {
    systemPrompt: "sys",
    prompt: "hi",
    model: "mock-model",
    auth: {
      kind: "api-key" as const,
      providerId: "mock",
      isAuthenticated: async () => true,
    },
    tools: [],
    canUseTool: async () => ({ allow: true }) as PermissionDecision,
    permissionMode: "workspace-write",
    maxTurns: 10,
    ...overrides,
  };
  return c;
}

async function collect(
  it: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// 1. Text-only turn
// ---------------------------------------------------------------------------

describe("NativeEngine: text-only turn", () => {
  it("produces text_delta then message_stop(end_turn)", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "hello" },
          { type: "text-delta", text: " world" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const engine = new NativeEngine({ provider });
    const events = await collect(engine.run(baseConfig()));

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      {
        type: "message_stop",
        stopReason: "end_turn",
        // The cumulative tally always carries the cache axes (docs/53 TE-17).
        usage: { ...DEFAULT_USAGE, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. One tool call
// ---------------------------------------------------------------------------

describe("NativeEngine: one tool call", () => {
  it("gates via canUseTool, dispatches, emits tool_result, continues to next turn", async () => {
    const provider = new MockProvider({
      scripts: [
        // turn 1: one tool call
        [
          { type: "tool-input-start", id: "t1", name: "bash" },
          { type: "tool-input-delta", id: "t1", delta: "{\"cmd\":\"ls\"}" },
          { type: "tool-call", id: "t1", name: "bash", input: { cmd: "ls" } },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        // turn 2: text reply
        [
          { type: "text-delta", text: "done" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher({
      scriptedResults: [{ status: "ok", output: "file.txt" }],
    });

    const gateCalls: Array<{ name: string; input: unknown }> = [];
    const engine = new NativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          canUseTool: async (name, input) => {
            gateCalls.push({ name, input });
            return { allow: true };
          },
        }),
      ),
    );

    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]).toEqual({ name: "bash", input: { cmd: "ls" } });
    expect(dispatcher.batchCalls).toHaveLength(1);
    expect(dispatcher.batchCalls[0]![0]!.name).toBe("bash");

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "tool_use_start",
      "tool_use_input",
      "tool_use_end",
      "tool_result",
      "text_delta",
      "message_stop",
    ]);

    const toolResult = events.find((e) => e.type === "tool_result") as Extract<
      NormalizedEvent,
      { type: "tool_result" }
    >;
    expect(toolResult.content).toBe("file.txt");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.toolUseId).toBe("t1");
  });
});

// ---------------------------------------------------------------------------
// 2a. Host threading — RunConfig.host reaches the dispatched ToolRequest.ctx
//     (regression for Tier 2 TEAM tools failing with "requires SwarmHost"
//     on non-Claude native engines — they bypass the SDK-path tool wrappers
//     that inject ctx.host, so the host must come via RunConfig.host.)
// ---------------------------------------------------------------------------

describe("NativeEngine: host threading into tool ctx", () => {
  function toolCallScripts(): readonly Script[] {
    return [
      [
        { type: "tool-call", id: "t1", name: "agent", input: { task: "x" } },
        { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
      ],
      [
        { type: "text-delta", text: "done" },
        { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
      ],
    ];
  }

  it("passes RunConfig.host through to the dispatched ToolRequest.ctx.host", async () => {
    const fakeHost = { __fake: "host" } as unknown as NonNullable<
      RunConfig["host"]
    >;
    const provider = new MockProvider({ scripts: toolCallScripts() });
    const dispatcher = new MockDispatcher();
    const engine = new NativeEngine({ provider });

    await collect(
      engine.run(
        baseConfig({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          host: fakeHost,
        }),
      ),
    );

    expect(dispatcher.batchCalls).toHaveLength(1);
    const req = dispatcher.batchCalls[0]![0]!;
    expect(req.ctx.host).toBe(fakeHost);
    expect(req.ctx.cwd).toBe(process.cwd());
  });

  it("omits ctx.host when RunConfig.host is unset (non-host tools unaffected)", async () => {
    const provider = new MockProvider({ scripts: toolCallScripts() });
    const dispatcher = new MockDispatcher();
    const engine = new NativeEngine({ provider });

    await collect(
      engine.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    expect(dispatcher.batchCalls).toHaveLength(1);
    const req = dispatcher.batchCalls[0]![0]!;
    expect(req.ctx.host).toBeUndefined();
    expect("host" in req.ctx).toBe(false);
    expect(req.ctx.cwd).toBe(process.cwd());
  });
});

// ---------------------------------------------------------------------------
// 2b. Reasoning continuity (#6.1)
// ---------------------------------------------------------------------------

describe("NativeEngine: reasoning continuity", () => {
  it("captures a reasoning block into the assistant message, before text/tool, for replay", async () => {
    const sig = '{"id":"rs_1","type":"reasoning","encrypted_content":"ENC","summary":[]}';
    const captured: ProviderRequest[] = [];
    const provider = new MockProvider({
      onRequest: (r) => captured.push(r),
      capabilities: { reasoning: true },
      scripts: [
        // turn 1: reasoning, then text, then a tool call (so the loop continues)
        [
          { type: "reasoning", signature: sig },
          { type: "text-delta", text: "thinking" },
          { type: "tool-call", id: "t1", name: "bash", input: { cmd: "ls" } },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        // turn 2: terminal
        [
          { type: "text-delta", text: "done" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher({ scriptedResults: [{ status: "ok", output: "x" }] });
    const engine = new NativeEngine({ provider });
    await collect(
      engine.run(
        baseConfig({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          canUseTool: async () => ({ allow: true }),
        }),
      ),
    );

    // Turn 2 replays the assistant turn — reasoning block must be first.
    const assistant = captured[1]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content.map((b) => b.type)).toEqual(["reasoning", "text", "tool_use"]);
    expect(assistant.content[0]).toEqual({ type: "reasoning", signature: sig });
  });
});

// ---------------------------------------------------------------------------
// 3. Permission denied
// ---------------------------------------------------------------------------

describe("NativeEngine: permission denied", () => {
  it("emits tool_result(isError:true) without calling dispatcher", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-input-start", id: "t1", name: "bash" },
          { type: "tool-call", id: "t1", name: "bash", input: { cmd: "rm -rf /" } },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "ok, aborted" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher();

    const engine = new NativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          canUseTool: async () => ({ allow: false, reason: "nope" }),
        }),
      ),
    );

    expect(dispatcher.batchCalls).toHaveLength(0);
    const toolResult = events.find((e) => e.type === "tool_result") as Extract<
      NormalizedEvent,
      { type: "tool_result" }
    >;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toBe("nope");
  });
});

// ---------------------------------------------------------------------------
// 4. Three parallel tool calls in one turn
// ---------------------------------------------------------------------------

describe("NativeEngine: three parallel tool calls", () => {
  it("fans out via dispatchBatch and emits 3 tool_result events", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-input-start", id: "a", name: "read" },
          { type: "tool-call", id: "a", name: "read", input: { path: "a.ts" } },
          { type: "tool-input-start", id: "b", name: "read" },
          { type: "tool-call", id: "b", name: "read", input: { path: "b.ts" } },
          { type: "tool-input-start", id: "c", name: "read" },
          { type: "tool-call", id: "c", name: "read", input: { path: "c.ts" } },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher();

    const engine = new NativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    const endEvents = events.filter((e) => e.type === "tool_use_end");
    const results = events.filter((e) => e.type === "tool_result");
    expect(endEvents.map((e) => (e as { id: string }).id)).toEqual(["a", "b", "c"]);
    expect(results.map((e) => (e as { toolUseId: string }).toolUseId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(dispatcher.batchCalls).toHaveLength(1);
    expect(dispatcher.batchCalls[0]!).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 5. AC 11 timing — all 3 execute start within 200ms (CI-stable relaxation).
// ---------------------------------------------------------------------------

describe("NativeEngine: parallel fan-out timing", () => {
  it("starts all 3 tool executions within 200ms of each other", async () => {
    const stamps: number[] = [];
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-call", id: "a", name: "read", input: {} },
          { type: "tool-call", id: "b", name: "read", input: {} },
          { type: "tool-call", id: "c", name: "read", input: {} },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [{ type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE }],
      ],
    });
    const dispatcher = new MockDispatcher({
      executionTimestamps: stamps,
      execDelayMs: 20,
    });

    const engine = new NativeEngine({ provider });
    await collect(
      engine.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    expect(stamps).toHaveLength(3);
    const spread = Math.max(...stamps) - Math.min(...stamps);
    expect(spread).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// 6. maxTurns / wall-clock budget (soft stop)
// ---------------------------------------------------------------------------

describe("NativeEngine: maxTurns budget", () => {
  it("soft-stops with stopReason max_turns after an explicit cap is exhausted", async () => {
    const makeToolTurn = (): Script => [
      { type: "tool-call", id: "t", name: "noop", input: {} },
      { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
    ];
    // Enough scripts for maxTurns iterations.
    const provider = new MockProvider({
      scripts: Array.from({ length: 10 }, () => makeToolTurn()),
    });
    const dispatcher = new MockDispatcher();

    const engine = new NativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({
          maxTurns: 3,
          dispatcher: dispatcher as unknown as ToolDispatcher,
        }),
      ),
    );

    const last = events[events.length - 1]!;
    expect(last.type).toBe("message_stop");
    expect((last as { stopReason: string }).stopReason).toBe("max_turns");
    // Soft stop — no error event.
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("does not cap turns when maxTurns is omitted (runs to natural end_turn)", async () => {
    const makeToolTurn = (): Script => [
      { type: "tool-call", id: "t", name: "noop", input: {} },
      { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
    ];
    // 200 tool turns then a natural stop — would exceed the old default of 100.
    const scripts: Script[] = Array.from({ length: 200 }, () => makeToolTurn());
    scripts.push([
      { type: "text-delta", text: "done" },
      { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
    ]);
    const provider = new MockProvider({ scripts });
    const dispatcher = new MockDispatcher();

    const engine = new NativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({
          maxTurns: undefined,
          dispatcher: dispatcher as unknown as ToolDispatcher,
        }),
      ),
    );

    const last = events[events.length - 1]!;
    expect(last.type).toBe("message_stop");
    expect((last as { stopReason: string }).stopReason).toBe("end_turn");
  });

  it("soft-stops with stopReason max_wall_clock when the wall-clock budget elapses", async () => {
    const makeToolTurn = (): Script => [
      { type: "tool-call", id: "t", name: "noop", input: {} },
      { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
    ];
    const provider = new MockProvider({
      scripts: Array.from({ length: 10 }, () => makeToolTurn()),
    });
    const dispatcher = new MockDispatcher();

    const engine = new NativeEngine({ provider });
    // 0ms budget → the boundary check fires immediately on the first turn.
    const events = await collect(
      engine.run(
        baseConfig({
          maxWallClockMs: 0,
          dispatcher: dispatcher as unknown as ToolDispatcher,
        }),
      ),
    );

    const last = events[events.length - 1]!;
    expect(last.type).toBe("message_stop");
    expect((last as { stopReason: string }).stopReason).toBe("max_wall_clock");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Compaction triggers
// ---------------------------------------------------------------------------

describe("NativeEngine: compaction triggers", () => {
  it("emits begin/end compaction events before provider stream", async () => {
    // Seed via resumeFrom to push enough tokens across the threshold.
    const bigText = "x".repeat(2_000);
    const preloaded: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
    ];
    const snap = makeSnapshot(preloaded, 0, 0, { inputTokens: 0, outputTokens: 0 });

    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const engine = new NativeEngine({
      provider,
      // Low threshold: preserveRecentMessages=2, maxEstimatedTokens=500.
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events = await collect(
      engine.run(baseConfig({ resumeFrom: snap })),
    );

    const compaction = events.filter((e) => e.type === "compaction");
    expect(compaction).toHaveLength(2);
    expect((compaction[0] as { payload: { phase: string } }).payload.phase).toBe(
      "begin",
    );
    expect((compaction[1] as { payload: { phase: string } }).payload.phase).toBe(
      "end",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Compaction boundary walk-back
// ---------------------------------------------------------------------------

describe("NativeEngine: compaction boundary walk-back", () => {
  it("surfaces boundaryWalkedBack:true when boundary falls mid-tool-pair", async () => {
    const bigText = "x".repeat(2_000);
    // After `run()` seeds the user prompt at the tail, messages length = 8.
    // preserveRecentMessages=3 → rawKeepFrom = 5. messages[5] is the
    // user-with-tool_result, messages[4] is the paired assistant-tool_use
    // — compactor must walk keepFrom back by 1 to preserve the pair.
    const preloaded: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }],
      },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
    ];
    const snap = makeSnapshot(preloaded, 0, 0, { inputTokens: 0, outputTokens: 0 });

    const provider = new MockProvider({
      scripts: [
        [{ type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE }],
      ],
    });
    const engine = new NativeEngine({
      provider,
      compactionConfig: { preserveRecentMessages: 3, maxEstimatedTokens: 500 },
    });
    const events = await collect(
      engine.run(baseConfig({ resumeFrom: snap })),
    );
    const end = events.find(
      (e) =>
        e.type === "compaction" &&
        (e as { payload: { phase: string } }).payload.phase === "end",
    );
    expect(end).toBeDefined();
    const meta = (end as {
      payload: { compact_metadata?: { boundaryWalkedBack?: boolean } };
    }).payload.compact_metadata;
    expect(meta?.boundaryWalkedBack).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Post-compaction health probe fires
// ---------------------------------------------------------------------------

describe("NativeEngine: post-compaction probe", () => {
  it("invokes dispatcher.dispatch('glob',{pattern:'*'},...) after compaction", async () => {
    const bigText = "x".repeat(2_000);
    const preloaded: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
      { role: "user", content: [{ type: "text", text: bigText }] },
      { role: "assistant", content: [{ type: "text", text: bigText }] },
    ];
    const snap = makeSnapshot(preloaded, 0, 0, { inputTokens: 0, outputTokens: 0 });

    const provider = new MockProvider({
      scripts: [
        [{ type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE }],
      ],
    });
    const dispatcher = new MockDispatcher();
    const engine = new NativeEngine({
      provider,
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    await collect(
      engine.run(
        baseConfig({
          resumeFrom: snap,
          dispatcher: dispatcher as unknown as ToolDispatcher,
        }),
      ),
    );

    const probe = dispatcher.dispatchCalls.find((c) => c.name === "glob");
    expect(probe).toBeDefined();
    expect(probe!.input).toEqual({ pattern: "*" });
    expect(dispatcher.dispatchCalls.filter((c) => c.name === "glob")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Post-compaction probe failure
// ---------------------------------------------------------------------------

describe("NativeEngine: post-compaction probe failure", () => {
  it("emits transport error but continues running", async () => {
    const bigText = "x".repeat(2_000);
    const preloaded: ProviderMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text", text: bigText }],
    }));
    const snap = makeSnapshot(preloaded, 0, 0, { inputTokens: 0, outputTokens: 0 });

    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "done" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher({ dispatchThrows: true });
    const engine = new NativeEngine({
      provider,
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events = await collect(
      engine.run(
        baseConfig({
          resumeFrom: snap,
          dispatcher: dispatcher as unknown as ToolDispatcher,
        }),
      ),
    );

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(
      (err as { error: { code: string; message: string } }).error.code,
    ).toBe("transport");
    expect(
      (err as { error: { message: string } }).error.message,
    ).toContain("post-compaction probe failed");
    // Continues: message_stop still emitted
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Resume from NativeSnapshot
// ---------------------------------------------------------------------------

describe("NativeEngine: resume from NativeSnapshot", () => {
  it("continues turn count and message buffer from snapshot", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-snap-"));
    try {
      // Run #1: produce a snapshot.
      const provider1 = new MockProvider({
        scripts: [
          [
            { type: "text-delta", text: "run1" },
            { type: "finish", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4 } },
          ],
        ],
      });
      const engine1 = new NativeEngine({ provider: provider1, sessionDir: tmp });
      await collect(engine1.run(baseConfig({ prompt: "first" })));

      const snapRaw = await fs.readFile(
        path.join(tmp, "native-snapshot.json"),
        "utf8",
      );
      const snap = JSON.parse(snapRaw) as { engineId: string; data: unknown };
      expect(snap.engineId).toBe("native");
      const data = snap.data as {
        messages: unknown[];
        turnCount: number;
        cumulativeUsage: Usage;
      };
      expect(data.turnCount).toBe(1);
      expect(data.messages.length).toBeGreaterThan(0);

      // Run #2: resume from snap.
      const provider2 = new MockProvider({
        scripts: [
          [
            { type: "text-delta", text: "run2" },
            { type: "finish", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 3 } },
          ],
        ],
      });
      const engine2 = new NativeEngine({ provider: provider2, sessionDir: tmp });
      const captured: ProviderRequest[] = [];
      (provider2 as unknown as { onRequest: (r: ProviderRequest) => void }).onRequest =
        (r) => captured.push(r);

      await collect(
        engine2.run(
          baseConfig({
            prompt: "second",
            resumeFrom: { engineId: "native", data: data },
          }),
        ),
      );

      // Engine sent messages = preserved snapshot messages + new prompt.
      expect(captured).toHaveLength(1);
      expect(captured[0]!.messages.length).toBe(data.messages.length + 1);

      // Snapshot on disk updated with accumulated turn count.
      const snap2Raw = await fs.readFile(
        path.join(tmp, "native-snapshot.json"),
        "utf8",
      );
      const snap2 = JSON.parse(snap2Raw) as {
        data: { turnCount: number; cumulativeUsage: Usage };
      };
      expect(snap2.data.turnCount).toBe(2);
      expect(snap2.data.cumulativeUsage).toEqual({
        inputTokens: 5,
        outputTokens: 7,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("cumulative usage sums cache read/write tokens across turns (docs/53 TE-17)", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "a" },
          {
            type: "finish",
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 100, cacheWriteInputTokens: 5 },
          },
        ],
        [
          { type: "text-delta", text: "b" },
          {
            type: "finish",
            stopReason: "end_turn",
            usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 200 },
          },
        ],
      ],
    });
    const engine = new NativeEngine({ provider });
    await collect(engine.run(baseConfig({ prompt: "one" })));
    const events = await collect(engine.run(baseConfig({ prompt: "two" })));
    const stop = events.filter((e) => e.type === "message_stop").at(-1) as {
      usage: Usage;
    };
    // Cache traffic must survive the cumulative tally — this ledger is the ONLY
    // usage subprocess workers forward (the eval telemetry path).
    expect(stop.usage).toEqual({
      inputTokens: 12,
      outputTokens: 2,
      cacheReadInputTokens: 300,
      cacheWriteInputTokens: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// 12. Resume rejection for wrong engineId
// ---------------------------------------------------------------------------

describe("NativeEngine: resume rejection", () => {
  it("emits error on non-native snapshot and returns without message_stop", async () => {
    const provider = new MockProvider({ scripts: [] });
    const engine = new NativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({
          resumeFrom: { engineId: "claude-agent-sdk", data: {} },
        }),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Capabilities shape
// ---------------------------------------------------------------------------

describe("NativeEngine: capabilities", () => {
  it("sets mcp:false, compaction:false, resume:true and mirrors provider caps", () => {
    const provider = new MockProvider({
      scripts: [],
      capabilities: {
        streaming: true,
        promptCache: true,
        parallelToolUse: true,
        maxContextTokens: 128_000,
        maxOutputTokens: 4_096,
      },
    });
    const engine = new NativeEngine({ provider });
    expect(engine.capabilities).toEqual({
      streaming: true,
      promptCache: true,
      parallelToolUse: true,
      mcp: false,
      compaction: false,
      resume: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
    });
  });
});

// ---------------------------------------------------------------------------
// 14. Cumulative usage across multiple run()s
// ---------------------------------------------------------------------------

describe("NativeEngine: cumulative usage", () => {
  it("accumulates across run() invocations", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "a" },
          {
            type: "finish",
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
        [
          { type: "text-delta", text: "b" },
          {
            type: "finish",
            stopReason: "end_turn",
            usage: { inputTokens: 7, outputTokens: 3 },
          },
        ],
      ],
    });
    const engine = new NativeEngine({ provider });

    await collect(engine.run(baseConfig()));
    expect(engine.getCumulativeUsage()).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    await collect(engine.run(baseConfig()));
    expect(engine.getCumulativeUsage()).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 15. reasoning-delta passes through without entering message array
// ---------------------------------------------------------------------------

describe("NativeEngine: reasoning-delta passthrough", () => {
  it("does not emit or persist reasoning-delta", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-reasoning-"));
    try {
      const provider = new MockProvider({
        scripts: [
          [
            { type: "reasoning-delta", text: "thinking..." },
            { type: "text-delta", text: "answer" },
            { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
          ],
        ],
      });
      const engine = new NativeEngine({ provider, sessionDir: tmp });
      const events = await collect(engine.run(baseConfig()));

      // No reasoning events in the normalized stream.
      expect(
        events.every(
          (e) =>
            e.type !== "text_delta" ||
            (e as { text: string }).text !== "thinking...",
        ),
      ).toBe(true);
      expect(
        events
          .filter((e) => e.type === "text_delta")
          .map((e) => (e as { text: string }).text),
      ).toEqual(["answer"]);

      // Inspect persisted snapshot — the assistant message must contain
      // ONLY the text block (reasoning-delta dropped, not merged).
      const snapRaw = await fs.readFile(
        path.join(tmp, "native-snapshot.json"),
        "utf8",
      );
      const snap = JSON.parse(snapRaw) as {
        data: { messages: ProviderMessage[] };
      };
      const persistedAssistant = snap.data.messages.find(
        (m) => m.role === "assistant",
      );
      expect(persistedAssistant).toBeDefined();
      expect(persistedAssistant!.content).toEqual([
        { type: "text", text: "answer" },
      ]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 16. Abort mid-stream
// ---------------------------------------------------------------------------

describe("NativeEngine: abort mid-stream", () => {
  it("stops cleanly when abort fires; no extra events", async () => {
    const ac = new AbortController();
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "partial" },
          { type: "text-delta", text: " more" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      delayMs: 10,
    });
    const engine = new NativeEngine({ provider });

    const iter = engine.run(baseConfig({ abort: ac.signal }));
    const collected: NormalizedEvent[] = [];
    (async () => {
      await new Promise((r) => setTimeout(r, 15));
      ac.abort();
    })();
    for await (const e of iter) collected.push(e);

    // At minimum we saw the first delta; we didn't see message_stop.
    expect(collected.some((e) => e.type === "message_stop")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 17. Mid-stream provider error
// ---------------------------------------------------------------------------

describe("NativeEngine: mid-stream provider error", () => {
  it("yields text_delta then error; no message_stop; exits", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "partial" },
          {
            type: "error",
            code: "transport",
            message: "network down",
            retryable: true,
          },
        ],
      ],
    });
    const engine = new NativeEngine({ provider });
    const events = await collect(engine.run(baseConfig()));

    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("error");
    expect(types).not.toContain("message_stop");

    const err = events.find((e) => e.type === "error") as Extract<
      NormalizedEvent,
      { type: "error" }
    >;
    expect(err.error.code).toBe("transport");
    expect(err.error.message).toBe("network down");
    expect(err.error.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 18. NativeSnapshot atomic write
// ---------------------------------------------------------------------------

describe("NativeEngine: atomic snapshot write", () => {
  it("creates native-snapshot.json and no stale .tmp file", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-atomic-"));
    try {
      const provider = new MockProvider({
        scripts: [
          [
            { type: "text-delta", text: "hello" },
            { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
          ],
        ],
      });
      const engine = new NativeEngine({ provider, sessionDir: tmp });
      await collect(engine.run(baseConfig()));

      const entries = await fs.readdir(tmp);
      expect(entries).toContain("native-snapshot.json");
      expect(entries).not.toContain("native-snapshot.json.tmp");

      const raw = await fs.readFile(path.join(tmp, "native-snapshot.json"), "utf8");
      const parsed = JSON.parse(raw) as { engineId: string };
      expect(parsed.engineId).toBe("native");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("creates sessionDir on demand when it doesn't exist", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "native-mkdir-"));
    const sessionDir = path.join(parent, "nested", "session");
    try {
      const provider = new MockProvider({
        scripts: [
          [
            { type: "text-delta", text: "ok" },
            { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
          ],
        ],
      });
      const engine = new NativeEngine({ provider, sessionDir });
      await collect(engine.run(baseConfig()));

      const entries = await fs.readdir(sessionDir);
      expect(entries).toContain("native-snapshot.json");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sessionId plumbing (#1)
// ---------------------------------------------------------------------------

describe("NativeEngine: sessionId plumbing", () => {
  it("forwards opts.sessionId to ProviderRequest.sessionId on every turn", async () => {
    const captured: Array<string | undefined> = [];
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      onRequest: (req) => captured.push(req.sessionId),
    });
    const engine = new NativeEngine({ provider, sessionId: "sess-xyz" });
    await collect(engine.run(baseConfig()));
    expect(captured).toEqual(["sess-xyz"]);
  });

  it("omits sessionId from ProviderRequest when constructor option is absent", async () => {
    const captured: Array<string | undefined> = [];
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      onRequest: (req) => captured.push(req.sessionId),
    });
    const engine = new NativeEngine({ provider });
    await collect(engine.run(baseConfig()));
    expect(captured).toEqual([undefined]);
  });
});
