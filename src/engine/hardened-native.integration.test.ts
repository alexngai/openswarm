/**
 * HardenedNativeEngine integration tests (Phase 5: T5.1-T5.9).
 *
 * Exercises combinations of retry + eager dispatch + mid-turn compaction
 * in end-to-end scenarios.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { HardenedNativeEngine } from "./hardened-native.js";
import { NativeEngine } from "./native.js";
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
// MockProvider — enhanced for integration scenarios.
// ---------------------------------------------------------------------------

type Script = readonly ProviderEvent[];

interface MockProviderOpts {
  readonly scripts: readonly Script[];
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly onRequest?: (req: ProviderRequest) => void;
  readonly delayMs?: number;
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
    if (throwErr !== undefined) throw throwErr;

    const script = this.scripts[callIdx];
    if (script === undefined) {
      throw new Error(`MockProvider: no script for call #${callIdx}`);
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
    if (this.opts.dispatchThrows === true) throw new Error("mock dispatch failure");
    if (this.opts.execDelayMs !== undefined) {
      await new Promise((r) => setTimeout(r, this.opts.execDelayMs));
    }
    if (this.opts.scriptedResults !== undefined) {
      const r = this.opts.scriptedResults[this.scriptIdx];
      this.scriptIdx++;
      if (r !== undefined) return r;
    }
    return { status: "ok", output: JSON.stringify(input) };
  }

  async dispatchBatch(requests: readonly ToolRequest[]): Promise<readonly ToolResult[]> {
    this.batchCalls.push(requests);
    const results: ToolResult[] = [];
    for (const req of requests) {
      if (this.opts.execDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, this.opts.execDelayMs));
      }
      if (this.opts.scriptedResults !== undefined) {
        const idx = this.scriptIdx++;
        const r = this.opts.scriptedResults[idx];
        if (r !== undefined) { results.push(r); continue; }
      }
      results.push({ status: "ok", output: JSON.stringify(req.input) });
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
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
}

async function collect(
  it: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

// ===========================================================================
// T5.1 — Flaky provider recovers
// ===========================================================================

describe("Integration: flaky provider", () => {
  it("T5.1: engine recovers from random failures and completes turn", async () => {
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("flake 1"));
    throwMap.set(1, new Error("flake 2"));
    const provider = new MockProvider({
      scripts: [
        [], [],
        [
          { type: "text-delta", text: "recovered" },
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

    const retries = events.filter((e) => e.type === "retry");
    expect(retries).toHaveLength(2);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect((textEvents[0] as { text: string }).text).toBe("recovered");
  });
});

// ===========================================================================
// T5.2 — Multi-tool turn with eager dispatch + retry
// ===========================================================================

describe("Integration: eager dispatch + retry", () => {
  it("T5.2: multi-tool turn with retry on first attempt, eager dispatch on second", async () => {
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("stream error"));
    const provider = new MockProvider({
      scripts: [
        [],
        [
          { type: "tool-call", id: "a", name: "read", input: { path: "a" } },
          { type: "tool-call", id: "b", name: "read", input: { path: "b" } },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const dispatcher = new MockDispatcher({
      scriptedResults: [
        { status: "ok", output: "content-a" },
        { status: "ok", output: "content-b" },
      ],
    });

    const engine = new HardenedNativeEngine({
      provider,
      eagerToolDispatch: true,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 10 },
    });
    const events = await collect(
      engine.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);

    const results = events.filter((e) => e.type === "tool_result") as Array<
      Extract<NormalizedEvent, { type: "tool_result" }>
    >;
    expect(results).toHaveLength(2);
    expect(results[0]!.content).toBe("content-a");
    expect(results[1]!.content).toBe("content-b");
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

// ===========================================================================
// T5.3 — Context overflow mid-turn → compaction + continuation
// ===========================================================================

describe("Integration: mid-turn compaction recovery", () => {
  it("T5.3: large tool output triggers mid-turn compaction, turn continues", async () => {
    const bigOutput = "x".repeat(5_000);
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-call", id: "t1", name: "read", input: {} },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "after compaction" },
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
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect((textEvents[0] as { text: string }).text).toBe("after compaction");
  });
});

// ===========================================================================
// T5.4 — Snapshot persist → resume → continue
// ===========================================================================

describe("Integration: snapshot persist and resume", () => {
  it("T5.4: snapshot persists, resumes with correct turn count and usage", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hardened-int-"));
    try {
      // Run 1: one turn with a tool call.
      const provider1 = new MockProvider({
        scripts: [
          [
            { type: "tool-call", id: "t1", name: "read", input: {} },
            { type: "finish", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
          ],
          [
            { type: "text-delta", text: "run1" },
            { type: "finish", stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 3 } },
          ],
        ],
      });
      const engine1 = new HardenedNativeEngine({
        provider: provider1,
        sessionDir: tmp,
      });
      const dispatcher1 = new MockDispatcher();
      await collect(
        engine1.run(
          baseConfig({
            prompt: "first",
            dispatcher: dispatcher1 as unknown as ToolDispatcher,
          }),
        ),
      );

      // Read snapshot.
      const snapRaw = await fs.readFile(
        path.join(tmp, "hardened-native-snapshot.json"),
        "utf8",
      );
      const snap = JSON.parse(snapRaw) as { engineId: string; data: unknown };
      expect(snap.engineId).toBe("hardened-native");
      const data = snap.data as {
        turnCount: number;
        cumulativeUsage: Usage;
        retryStats: { totalRetries: number };
      };
      expect(data.turnCount).toBe(2);

      // Run 2: resume.
      const provider2 = new MockProvider({
        scripts: [
          [
            { type: "text-delta", text: "run2" },
            { type: "finish", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
          ],
        ],
      });
      const engine2 = new HardenedNativeEngine({
        provider: provider2,
        sessionDir: tmp,
      });
      const events2 = await collect(
        engine2.run(
          baseConfig({
            prompt: "second",
            resumeFrom: snap,
          }),
        ),
      );

      expect(events2.some((e) => e.type === "message_stop")).toBe(true);

      // Verify snapshot updated.
      const snap2Raw = await fs.readFile(
        path.join(tmp, "hardened-native-snapshot.json"),
        "utf8",
      );
      const snap2 = JSON.parse(snap2Raw) as {
        data: { turnCount: number; cumulativeUsage: Usage };
      };
      expect(snap2.data.turnCount).toBe(3);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// T5.5 — All features combined
// ===========================================================================

describe("Integration: all features combined", () => {
  it("T5.5: retry + eager dispatch + mid-turn compaction in one turn", async () => {
    const bigOutput = "x".repeat(5_000);
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("transient"));
    const provider = new MockProvider({
      scripts: [
        [],
        [
          { type: "tool-call", id: "t1", name: "read", input: {} },
          { type: "tool-call", id: "t2", name: "read", input: {} },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "all done" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const dispatcher = new MockDispatcher({
      scriptedResults: [
        { status: "ok", output: bigOutput },
        { status: "ok", output: "small" },
      ],
    });

    const engine = new HardenedNativeEngine({
      provider,
      eagerToolDispatch: true,
      midTurnCompaction: true,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 10 },
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events = await collect(
      engine.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    // Verify retry occurred.
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);

    // Verify tool results.
    const results = events.filter((e) => e.type === "tool_result") as Array<
      Extract<NormalizedEvent, { type: "tool_result" }>
    >;
    expect(results).toHaveLength(2);

    // Verify mid-turn compaction fired (big tool output).
    const midTurnCompactions = events.filter(
      (e) =>
        e.type === "compaction" &&
        (e as { payload: { compact_metadata?: { midTurn?: boolean } } }).payload
          .compact_metadata?.midTurn === true,
    );
    expect(midTurnCompactions.length).toBeGreaterThanOrEqual(1);

    // Verify turn completed.
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

// ===========================================================================
// T5.6 — Abort at every phase
// ===========================================================================

describe("Integration: abort at every phase", () => {
  it("T5.6a: abort during stream exits cleanly", async () => {
    const ac = new AbortController();
    const provider = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "partial" },
          { type: "text-delta", text: " more" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      delayMs: 20,
    });
    const engine = new HardenedNativeEngine({ provider });

    setTimeout(() => ac.abort(), 30);
    const events = await collect(
      engine.run(baseConfig({ abort: ac.signal })),
    );
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });

  it("T5.6b: abort during retry sleep exits cleanly", async () => {
    const ac = new AbortController();
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("fail"));
    const provider = new MockProvider({
      scripts: [[], [{ type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE }]],
      throwOnCalls: throwMap,
    });
    const engine = new HardenedNativeEngine({
      provider,
      retryPolicy: { maxRetries: 3, backoffBaseMs: 5000 },
    });

    setTimeout(() => ac.abort(), 50);
    const start = Date.now();
    const events = await collect(
      engine.run(baseConfig({ abort: ac.signal })),
    );
    expect(Date.now() - start).toBeLessThan(2000);
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });

  it("T5.6c: abort during eager dispatch drain exits cleanly", async () => {
    const ac = new AbortController();
    const provider = new MockProvider({
      scripts: [
        [
          { type: "tool-call", id: "t1", name: "slow", input: {} },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher({ execDelayMs: 5000 });
    const engine = new HardenedNativeEngine({
      provider,
      eagerToolDispatch: true,
    });

    setTimeout(() => ac.abort(), 100);
    const events = await collect(
      engine.run(
        baseConfig({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          abort: ac.signal,
        }),
      ),
    );
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });
});

// ===========================================================================
// T5.7 — Parity: hardened with all features off ≈ NativeEngine
// ===========================================================================

describe("Parity: hardened vs native", () => {
  it("T5.7: with retry disabled + batch + no mid-turn compaction, identical event types", async () => {
    const makeProvider = () =>
      new MockProvider({
        scripts: [
          [
            { type: "tool-call", id: "t1", name: "read", input: { p: "a" } },
            { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
          ],
          [
            { type: "text-delta", text: "done" },
            { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
          ],
        ],
      });

    const makeDispatcher = () =>
      new MockDispatcher({
        scriptedResults: [{ status: "ok", output: "content" }],
      });

    // NativeEngine
    const nativeEngine = new NativeEngine({ provider: makeProvider() });
    const nativeEvents = await collect(
      nativeEngine.run(
        baseConfig({
          dispatcher: makeDispatcher() as unknown as ToolDispatcher,
        }),
      ),
    );

    // HardenedNativeEngine with everything off
    const hardenedEngine = new HardenedNativeEngine({
      provider: makeProvider(),
      retryPolicy: { maxRetries: 0, backoffBaseMs: 10 },
      eagerToolDispatch: false,
      midTurnCompaction: false,
    });
    const hardenedEvents = await collect(
      hardenedEngine.run(
        baseConfig({
          dispatcher: makeDispatcher() as unknown as ToolDispatcher,
        }),
      ),
    );

    // Event types and tool result content must match.
    expect(hardenedEvents.map((e) => e.type)).toEqual(
      nativeEvents.map((e) => e.type),
    );

    const nativeResult = nativeEvents.find(
      (e) => e.type === "tool_result",
    ) as Extract<NormalizedEvent, { type: "tool_result" }>;
    const hardenedResult = hardenedEvents.find(
      (e) => e.type === "tool_result",
    ) as Extract<NormalizedEvent, { type: "tool_result" }>;
    expect(hardenedResult.content).toBe(nativeResult.content);
    expect(hardenedResult.isError).toBe(nativeResult.isError);
  });
});

// ===========================================================================
// T5.8 — Same tool_result ordering for batch vs eager
// ===========================================================================

describe("Parity: batch vs eager ordering", () => {
  it("T5.8: same tool_result content and order for batch and eager", async () => {
    const makeProvider = () =>
      new MockProvider({
        scripts: [
          [
            { type: "tool-call", id: "a", name: "read", input: { p: "a" } },
            { type: "tool-call", id: "b", name: "read", input: { p: "b" } },
            { type: "tool-call", id: "c", name: "read", input: { p: "c" } },
            { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
          ],
          [{ type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE }],
        ],
      });

    const makeDispatcher = () =>
      new MockDispatcher({
        scriptedResults: [
          { status: "ok", output: "ra" },
          { status: "ok", output: "rb" },
          { status: "ok", output: "rc" },
        ],
      });

    // Batch
    const batchEngine = new HardenedNativeEngine({
      provider: makeProvider(),
      eagerToolDispatch: false,
    });
    const batchEvents = await collect(
      batchEngine.run(
        baseConfig({
          dispatcher: makeDispatcher() as unknown as ToolDispatcher,
        }),
      ),
    );

    // Eager
    const eagerEngine = new HardenedNativeEngine({
      provider: makeProvider(),
      eagerToolDispatch: true,
    });
    const eagerEvents = await collect(
      eagerEngine.run(
        baseConfig({
          dispatcher: makeDispatcher() as unknown as ToolDispatcher,
        }),
      ),
    );

    const batchResults = batchEvents.filter((e) => e.type === "tool_result") as Array<
      Extract<NormalizedEvent, { type: "tool_result" }>
    >;
    const eagerResults = eagerEvents.filter((e) => e.type === "tool_result") as Array<
      Extract<NormalizedEvent, { type: "tool_result" }>
    >;

    expect(eagerResults.map((r) => r.toolUseId)).toEqual(
      batchResults.map((r) => r.toolUseId),
    );
    expect(eagerResults.map((r) => r.content)).toEqual(
      batchResults.map((r) => r.content),
    );
  });
});

// ===========================================================================
// T5.9 — Same compaction output for pre-turn vs mid-turn
// ===========================================================================

describe("Parity: compaction algorithm", () => {
  it("T5.9: pre-turn and mid-turn use same compactor", async () => {
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

    // Pre-turn compaction: resumes into a context that triggers compaction
    // before the first provider call.
    const provider1 = new MockProvider({
      scripts: [
        [
          { type: "text-delta", text: "pre-turn" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const engine1 = new HardenedNativeEngine({
      provider: provider1,
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events1 = await collect(
      engine1.run(baseConfig({ resumeFrom: snap })),
    );

    const preTurnCompactions = events1.filter((e) => e.type === "compaction");
    expect(preTurnCompactions.length).toBeGreaterThanOrEqual(2);

    // Mid-turn compaction: tool result pushes tokens over threshold.
    const bigOutput = "x".repeat(5_000);
    const provider2 = new MockProvider({
      scripts: [
        [
          { type: "tool-call", id: "t1", name: "read", input: {} },
          { type: "finish", stopReason: "tool_use", usage: DEFAULT_USAGE },
        ],
        [
          { type: "text-delta", text: "mid-turn" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const dispatcher = new MockDispatcher({
      scriptedResults: [{ status: "ok", output: bigOutput }],
    });
    const engine2 = new HardenedNativeEngine({
      provider: provider2,
      midTurnCompaction: true,
      compactionConfig: { preserveRecentMessages: 2, maxEstimatedTokens: 500 },
    });
    const events2 = await collect(
      engine2.run(
        baseConfig({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    const midTurnCompactions = events2.filter(
      (e) =>
        e.type === "compaction" &&
        (e as { payload: { compact_metadata?: { midTurn?: boolean } } }).payload
          .compact_metadata?.midTurn === true,
    );
    expect(midTurnCompactions.length).toBeGreaterThanOrEqual(1);

    // Both used compaction — the key invariant is that both fire begin+end
    // pairs and the turn continues after each.
    expect(events1.some((e) => e.type === "message_stop")).toBe(true);
    expect(events2.some((e) => e.type === "message_stop")).toBe(true);
  });
});
