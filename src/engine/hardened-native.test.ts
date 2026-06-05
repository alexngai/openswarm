/**
 * HardenedNativeEngine test suite.
 *
 * Phase 0 (P0.4): baseline tests copied from native.test.ts to verify the
 * skeleton passes the same tests as NativeEngine.
 *
 * Phase 1 (P1.4): retry-specific tests (T1.1-T1.7).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { HardenedNativeEngine } from "./hardened-native.js";
import { makeHardenedSnapshot } from "./hardened-native-snapshot.js";
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
  readonly scripts: readonly Script[];
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly onRequest?: (req: ProviderRequest) => void;
  readonly delayMs?: number;
  /** When set, throw on these stream() call indices instead of yielding script. */
  readonly throwOnCalls?: ReadonlyMap<number, Error>;
}

class MockProvider implements Provider {
  readonly id = "mock";
  readonly model = "mock-model" as never;
  readonly capabilities: ProviderCapabilities;

  private readonly scripts: readonly Script[];
  private readonly onRequest?: (req: ProviderRequest) => void;
  private readonly delayMs: number;
  private readonly throwOnCalls: ReadonlyMap<number, Error>;
  private streamIdx = 0;

  constructor(opts: MockProviderOpts) {
    this.scripts = opts.scripts;
    if (opts.onRequest !== undefined) this.onRequest = opts.onRequest;
    this.delayMs = opts.delayMs ?? 0;
    this.throwOnCalls = opts.throwOnCalls ?? new Map();
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

    const callIdx = this.streamIdx;
    this.streamIdx++;

    const throwErr = this.throwOnCalls.get(callIdx);
    if (throwErr !== undefined) {
      throw throwErr;
    }

    const script = this.scripts[callIdx];
    if (script === undefined) {
      throw new Error(
        `MockProvider: no script for stream() call #${callIdx}`,
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
// MockDispatcher
// ---------------------------------------------------------------------------

interface MockDispatcherOpts {
  readonly scriptedResults?: readonly ToolResult[];
  readonly dispatchThrows?: boolean;
  readonly executionTimestamps?: number[];
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
      headers: async () => ({}),
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

// ===========================================================================
// BASELINE TESTS (mirrors native.test.ts)
// ===========================================================================

describe("HardenedNativeEngine: text-only turn", () => {
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
    const engine = new HardenedNativeEngine({ provider });
    const events = await collect(engine.run(baseConfig()));

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      { type: "message_stop", stopReason: "end_turn", usage: DEFAULT_USAGE },
    ]);
  });
});

describe("HardenedNativeEngine: one tool call", () => {
  it("gates via canUseTool, dispatches, emits tool_result, continues to next turn", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-input-start", id: "t1", name: "bash" },
          { type: "tool-input-delta", id: "t1", delta: '{"cmd":"ls"}' },
          { type: "tool-call", id: "t1", name: "bash", input: { cmd: "ls" } },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
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
    const engine = new HardenedNativeEngine({ provider });
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
  });
});

describe("HardenedNativeEngine: permission denied", () => {
  it("emits tool_result(isError:true) without calling dispatcher", async () => {
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-input-start", id: "t1", name: "bash" },
          { type: "tool-call", id: "t1", name: "bash", input: { cmd: "rm" } },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher();

    const engine = new HardenedNativeEngine({ provider });
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

describe("HardenedNativeEngine: three parallel tool calls", () => {
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

    const engine = new HardenedNativeEngine({ provider });
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

describe("HardenedNativeEngine: maxTurns exceeded", () => {
  it("emits invalid_request error after maxTurns", async () => {
    const makeToolTurn = (): Script => [
      { type: "tool-call", id: "t", name: "noop", input: {} },
      { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
    ];
    const provider = new MockProvider({
      scripts: Array.from({ length: 10 }, () => makeToolTurn()),
    });
    const dispatcher = new MockDispatcher();

    const engine = new HardenedNativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({
          maxTurns: 3,
          dispatcher: dispatcher as unknown as ToolDispatcher,
        }),
      ),
    );

    const last = events[events.length - 1]!;
    expect(last.type).toBe("error");
    expect(
      (last as { error: { code: string } }).error.code,
    ).toBe("invalid_request");
  });
});

describe("HardenedNativeEngine: compaction triggers", () => {
  it("emits begin/end compaction events before provider stream", async () => {
    const bigText = "x".repeat(2_000);
    const preloaded: ProviderMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text", text: bigText }],
    }));
    const snap = makeHardenedSnapshot(
      preloaded, 0, 0,
      { inputTokens: 0, outputTokens: 0 },
      { totalRetries: 0, retriesThisTurn: 0 },
    );

    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const engine = new HardenedNativeEngine({
      provider,
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events = await collect(
      engine.run(baseConfig({ resumeFrom: snap })),
    );

    const compaction = events.filter((e) => e.type === "compaction");
    expect(compaction).toHaveLength(2);
    expect((compaction[0] as { payload: { phase: string } }).payload.phase).toBe("begin");
    expect((compaction[1] as { payload: { phase: string } }).payload.phase).toBe("end");
  });
});

describe("HardenedNativeEngine: capabilities", () => {
  it("sets retry:true and mirrors provider caps", () => {
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
    const engine = new HardenedNativeEngine({ provider });
    expect(engine.capabilities).toEqual({
      streaming: true,
      promptCache: true,
      parallelToolUse: true,
      mcp: false,
      compaction: false,
      resume: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
      retry: true,
      eagerToolDispatch: false,
    });
  });
});

describe("HardenedNativeEngine: cumulative usage", () => {
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
    const engine = new HardenedNativeEngine({ provider });

    await collect(engine.run(baseConfig()));
    expect(engine.getCumulativeUsage()).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
    await collect(engine.run(baseConfig()));
    expect(engine.getCumulativeUsage()).toEqual({
      inputTokens: 17,
      outputTokens: 8,
    });
  });
});

describe("HardenedNativeEngine: resume rejection", () => {
  it("emits error on non-hardened-native snapshot", async () => {
    const provider = new MockProvider({ scripts: [] });
    const engine = new HardenedNativeEngine({ provider });
    const events = await collect(
      engine.run(
        baseConfig({
          resumeFrom: { engineId: "native", data: {} },
        }),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
  });
});

describe("HardenedNativeEngine: abort mid-stream", () => {
  it("stops cleanly when abort fires", async () => {
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
    const engine = new HardenedNativeEngine({ provider });

    const iter = engine.run(baseConfig({ abort: ac.signal }));
    const collected: NormalizedEvent[] = [];
    (async () => {
      await new Promise((r) => setTimeout(r, 15));
      ac.abort();
    })();
    for await (const e of iter) collected.push(e);

    expect(collected.some((e) => e.type === "message_stop")).toBe(false);
  });
});

describe("HardenedNativeEngine: mid-stream provider error", () => {
  it("yields error; no message_stop; exits", async () => {
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
    const engine = new HardenedNativeEngine({ provider });
    const events = await collect(engine.run(baseConfig()));

    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("error");
    expect(types).not.toContain("message_stop");
  });
});

describe("HardenedNativeEngine: snapshot write", () => {
  it("creates hardened-native-snapshot.json", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hardened-snap-"));
    try {
      const provider = new MockProvider({
        scripts: [
          [
            { type: "text-delta", text: "hello" },
            { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
          ],
        ],
      });
      const engine = new HardenedNativeEngine({ provider, sessionDir: tmp });
      await collect(engine.run(baseConfig()));

      const entries = await fs.readdir(tmp);
      expect(entries).toContain("hardened-native-snapshot.json");
      expect(entries).not.toContain("hardened-native-snapshot.json.tmp");

      const raw = await fs.readFile(
        path.join(tmp, "hardened-native-snapshot.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as { engineId: string };
      expect(parsed.engineId).toBe("hardened-native");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// PHASE 1 — RETRY TESTS (T1.1-T1.7)
// ===========================================================================

describe("HardenedNativeEngine: retry", () => {
  // T1.1 — Provider fails once with transport error, succeeds on retry.
  it("T1.1: retries on transport error and completes", async () => {
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("connection reset"));
    const provider = new MockProvider({
      scripts: [
        // script[0] is not used (throwOnCalls overrides)
        [],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 10 },
    });
    const events = await collect(engine.run(baseConfig()));

    const retryEvents = events.filter((e) => e.type === "retry");
    expect(retryEvents).toHaveLength(1);
    expect((retryEvents[0] as { attempt: number }).attempt).toBe(1);

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  // T1.2 — Provider fails with context_overflow → no retry.
  it("T1.2: does not retry on context_overflow", async () => {
    const err = Object.assign(new Error("context too long"), {
      code: "context_overflow",
      retryable: false,
    });
    const throwMap = new Map<number, Error>();
    throwMap.set(0, err);
    const provider = new MockProvider({
      scripts: [[]],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 10 },
    });
    const events = await collect(engine.run(baseConfig()));

    expect(events.filter((e) => e.type === "retry")).toHaveLength(0);
    expect(events.some((e) => e.type === "error")).toBe(true);
    const errEvent = events.find((e) => e.type === "error") as Extract<
      NormalizedEvent,
      { type: "error" }
    >;
    expect(errEvent.error.code).toBe("context_overflow");
  });

  // T1.3 — Provider fails maxRetries+1 times → final error.
  it("T1.3: emits error after exhausting retries", async () => {
    const throwMap = new Map<number, Error>();
    for (let i = 0; i <= 3; i++) {
      throwMap.set(i, new Error("still broken"));
    }
    const provider = new MockProvider({
      scripts: [[], [], [], []],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 10 },
    });
    const events = await collect(engine.run(baseConfig()));

    const retryEvents = events.filter((e) => e.type === "retry");
    expect(retryEvents).toHaveLength(3);

    const errEvents = events.filter((e) => e.type === "error");
    expect(errEvents).toHaveLength(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });

  // T1.4 — Exponential backoff timing.
  it("T1.4: exponential backoff delays are correct", async () => {
    const throwMap = new Map<number, Error>();
    for (let i = 0; i < 3; i++) {
      throwMap.set(i, new Error("fail"));
    }
    const provider = new MockProvider({
      scripts: [
        [], [], [],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 100 },
    });
    const events = await collect(engine.run(baseConfig()));

    const retryEvents = events.filter((e) => e.type === "retry") as Array<
      Extract<NormalizedEvent, { type: "retry" }>
    >;
    expect(retryEvents).toHaveLength(3);
    expect(retryEvents[0]!.delayMs).toBe(100);
    expect(retryEvents[1]!.delayMs).toBe(200);
    expect(retryEvents[2]!.delayMs).toBe(400);
  });

  // T1.5 — Abort during backoff sleep exits immediately.
  it("T1.5: abort during backoff exits immediately", async () => {
    const ac = new AbortController();
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("fail"));
    const provider = new MockProvider({
      scripts: [
        [],
        [
          { type: "text-delta", text: "should not see" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 5000 },
    });

    const startTime = Date.now();
    // Abort after 50ms — well before the 5000ms backoff.
    setTimeout(() => ac.abort(), 50);

    const events = await collect(
      engine.run(baseConfig({ abort: ac.signal })),
    );

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(1000);
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });

  // T1.6 — Cumulative usage includes retried turns.
  it("T1.6: cumulative usage includes retried turns", async () => {
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("fail"));
    const provider = new MockProvider({
      scripts: [
        [],
        [
          { type: "text-delta", text: "ok" },
          {
            type: "finish",
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 10 },
    });
    await collect(engine.run(baseConfig()));

    expect(engine.getCumulativeUsage()).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  // T1.7 — retry NormalizedEvent emitted with correct fields.
  it("T1.7: retry event has correct attempt/delay/error", async () => {
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("conn refused"));
    const provider = new MockProvider({
      scripts: [
        [],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 50 },
    });
    const events = await collect(engine.run(baseConfig()));

    const retryEvent = events.find((e) => e.type === "retry") as Extract<
      NormalizedEvent,
      { type: "retry" }
    >;
    expect(retryEvent).toBeDefined();
    expect(retryEvent.attempt).toBe(1);
    expect(retryEvent.maxRetries).toBe(3);
    expect(retryEvent.delayMs).toBe(50);
    expect(retryEvent.error.code).toBe("transport");
    expect(retryEvent.error.message).toBe("conn refused");
  });
});

// ===========================================================================
// MID-TURN COMPACTION TESTS (T3.1, T3.5)
// ===========================================================================

describe("HardenedNativeEngine: mid-turn compaction", () => {
  // T3.1 — Tool results push tokens above threshold → mid-turn compaction fires.
  it("T3.1: mid-turn compaction fires when tool results exceed threshold", async () => {
    const bigOutput = "x".repeat(5_000);
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-call", id: "t1", name: "read", input: {} },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher({
      scriptedResults: [{ status: "ok", output: bigOutput }],
    });

    const engine = new HardenedNativeEngine({
      provider,
      midTurnCompaction: true,
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events = await collect(
      engine.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    const compaction = events.filter((e) => e.type === "compaction");
    expect(compaction.length).toBeGreaterThanOrEqual(2);
    const midTurn = compaction.find(
      (e) =>
        (e as { payload: { compact_metadata?: { midTurn?: boolean } } }).payload
          .compact_metadata?.midTurn === true,
    );
    expect(midTurn).toBeDefined();
  });

  // T3.5 — midTurnCompaction: false → no mid-turn compaction.
  it("T3.5: no mid-turn compaction when disabled", async () => {
    const bigOutput = "x".repeat(5_000);
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-call", id: "t1", name: "read", input: {} },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher({
      scriptedResults: [{ status: "ok", output: bigOutput }],
    });

    const engine = new HardenedNativeEngine({
      provider,
      midTurnCompaction: false,
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events = await collect(
      engine.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    const compaction = events.filter((e) => e.type === "compaction");
    const midTurn = compaction.filter(
      (e) =>
        (e as { payload: { compact_metadata?: { midTurn?: boolean } } }).payload
          .compact_metadata?.midTurn === true,
    );
    expect(midTurn).toHaveLength(0);
  });
});
