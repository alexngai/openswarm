/**
 * FX-RETRY-001..010 — a retried or cancelled turn performs no effect twice and
 * leaves none unaccounted for (docs/63 `WP-05`).
 *
 * Eager dispatch starts a tool the moment the provider announces the call,
 * before the stream that announced it has finished. When that stream then
 * fails, the engine retries it, and the retried stream announces the same calls
 * again. Resetting the in-flight map keeps the stale *results* from being
 * drained, which is what `T1.8` covers — but the effects those calls already
 * had are not undone by forgetting their promises.
 *
 * These tests count dispatches rather than inspecting results, because a
 * duplicated write is invisible in the result the model finally sees. Two
 * mechanisms are being exercised and it is worth keeping them apart: nothing
 * that can leave a trace is speculated on at all, which is what most of these
 * assert, and the ledger accounts for anything that did start, which
 * `operation-ledger.test.ts` covers decision by decision.
 */

import { describe, it, expect } from "vitest";

import { HardenedNativeEngine } from "./hardened-native.js";
import type { RunConfig, PermissionDecision } from "./index.js";
import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "../providers/index.js";
import type { NormalizedEvent, Usage } from "../core/types.js";
import type { ToolDispatcher, ToolRequest } from "../tools/dispatcher.js";
import type { ToolImpl, ToolResult } from "../tools/types.js";
import { ToolAccesses } from "../tools/access.js";

const USAGE: Usage = { inputTokens: 1, outputTokens: 1 };

/** Lets a test observe the world between two streamed events. */
type Interleave = (index: number) => Promise<void>;

class ScriptedProvider implements Provider {
  readonly id = "mock";
  readonly model = "mock-model" as never;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    promptCache: false,
    parallelToolUse: true,
    vision: false,
    reasoning: false,
    maxContextTokens: 200_000,
    maxOutputTokens: 16_000,
  };

  private idx = 0;

  constructor(
    private readonly scripts: readonly (readonly ProviderEvent[])[],
    private readonly failAfter: ReadonlyMap<number, Error> = new Map(),
    private readonly between?: Interleave,
  ) {}

  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const call = this.idx++;
    const script = this.scripts[call];
    if (script === undefined) throw new Error(`no script for stream #${call}`);
    for (const ev of script) {
      yield ev;
      if (this.between !== undefined) await this.between(call);
    }
    const boom = this.failAfter.get(call);
    if (boom !== undefined) throw boom;
  }
}

/** Records every dispatch so duplicates are countable. */
class CountingDispatcher {
  readonly dispatched: Array<{ name: string; input: unknown }> = [];

  constructor(
    private readonly registry: ReadonlyMap<string, ToolImpl>,
    private readonly behaviour: {
      readonly delayMs?: number;
      readonly throwOn?: string;
      readonly hang?: string;
    } = {},
  ) {}

  get(name: string): ToolImpl | undefined {
    return this.registry.get(name);
  }

  async dispatch(name: string, input: unknown): Promise<ToolResult> {
    this.dispatched.push({ name, input });
    if (this.behaviour.hang === name) await new Promise(() => {});
    if (this.behaviour.delayMs !== undefined) {
      await new Promise((r) => setTimeout(r, this.behaviour.delayMs));
    }
    if (this.behaviour.throwOn === name) throw new Error("worker died mid-call");
    return { status: "ok", output: `did ${name}` };
  }

  async dispatchBatch(
    requests: readonly ToolRequest[],
  ): Promise<readonly ToolResult[]> {
    const out: ToolResult[] = [];
    for (const req of requests) out.push(await this.dispatch(req.name, req.input));
    return out;
  }
}

/** A tool whose declared accesses put it in one idempotency class. */
function tool(name: string, declare: (input: unknown) => ToolAccesses): ToolImpl {
  return {
    spec: {
      name,
      description: name,
      inputSchema: { type: "object" },
      requiredPermission: "write",
      tier: 0,
    },
    execute: async () => ({ status: "ok" as const, output: name }),
    accesses: declare,
  };
}

const pathOf = (input: unknown): string => (input as { path?: string }).path ?? "/tmp/x";

const WRITE = tool("write", (i) => ToolAccesses.writeFile(pathOf(i)));
const READ = tool("read", (i) => ToolAccesses.readFile(pathOf(i)));
/** What bash and every plugin tool declare: "I cannot name what I touch." */
const OPAQUE = tool("bash", () => ToolAccesses.all());

function registry(...tools: ToolImpl[]): ReadonlyMap<string, ToolImpl> {
  return new Map(tools.map((t) => [t.spec.name, t]));
}

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
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
}

async function collect(
  events: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/**
 * One turn that announces `calls`, fails, and is retried with the same calls.
 * The retried attempt succeeds, so anything the first attempt did that was not
 * accounted for shows up as a second dispatch.
 */
function retriedTurn(
  calls: readonly { id: string; name: string; input: unknown }[],
  between?: Interleave,
) {
  const announce = calls.map(
    (c): ProviderEvent => ({ type: "tool-call", id: c.id, name: c.name, input: c.input }),
  );
  return new ScriptedProvider(
    [
      announce,
      [...announce, { type: "finish", stopReason: "tool_use", usage: USAGE }],
      [
        { type: "text-delta", text: "done" },
        { type: "finish", stopReason: "end_turn", usage: USAGE },
      ],
    ],
    new Map([[0, new Error("transport reset after the calls were announced")]]),
    between,
  );
}

function engineWith(provider: Provider, extra: Record<string, unknown> = {}) {
  return new HardenedNativeEngine({
    provider,
    eagerToolDispatch: true,
    retryPolicy: { maxRetries: 3, backoffBaseMs: 1 },
    ...extra,
  });
}

const countOf = (d: CountingDispatcher, name: string): number =>
  d.dispatched.filter((c) => c.name === name).length;

describe("a retried stream re-announcing its tool calls", () => {
  it("FX-RETRY-001 performs a mutating call once, not once per attempt", async () => {
    const dispatcher = new CountingDispatcher(registry(WRITE));
    await collect(
      engineWith(
        retriedTurn([{ id: "c1", name: "write", input: { path: "/tmp/f", content: "x" } }]),
      ).run(config({ dispatcher: dispatcher as unknown as ToolDispatcher })),
    );

    expect(countOf(dispatcher, "write")).toBe(1);
  });

  it("FX-RETRY-002 still repeats a read, which nothing can observe twice", async () => {
    const dispatcher = new CountingDispatcher(registry(READ));
    const events = await collect(
      engineWith(retriedTurn([{ id: "c1", name: "read", input: { path: "/tmp/f" } }])).run(
        config({ dispatcher: dispatcher as unknown as ToolDispatcher }),
      ),
    );

    // Asserting this keeps the fix from degenerating into "never speculate".
    expect(countOf(dispatcher, "read")).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });

  it("FX-RETRY-003 never starts a mutating call while the stream is open", async () => {
    // The stronger property behind FX-RETRY-001: the write is not merely
    // deduplicated after the fact, it is never speculated on. A turn that is
    // abandoned before it finishes should leave the workspace untouched.
    const dispatcher = new CountingDispatcher(registry(WRITE));
    const duringStream: number[] = [];

    await collect(
      engineWith(
        retriedTurn(
          [{ id: "c1", name: "write", input: { path: "/tmp/f", content: "x" } }],
          async (stream) => {
            // Only while a stream that announced the write is still open. The
            // third stream is the following turn, by which point the write has
            // legitimately run.
            if (stream > 1) return;
            // Let any eager dispatch actually run before looking.
            await new Promise((r) => setImmediate(r));
            duringStream.push(dispatcher.dispatched.length);
          },
        ),
      ).run(config({ dispatcher: dispatcher as unknown as ToolDispatcher })),
    );

    expect(duringStream.every((n) => n === 0)).toBe(true);
    expect(countOf(dispatcher, "write")).toBe(1);
  });

  it("FX-RETRY-004 treats an unnameable effect as strictly as a known mutation", async () => {
    const dispatcher = new CountingDispatcher(registry(OPAQUE));
    const duringStream: number[] = [];

    await collect(
      engineWith(
        retriedTurn([{ id: "c1", name: "bash", input: { command: "deploy" } }], async (stream) => {
          if (stream > 1) return;
          await new Promise((r) => setImmediate(r));
          duringStream.push(dispatcher.dispatched.length);
        }),
      ).run(config({ dispatcher: dispatcher as unknown as ToolDispatcher })),
    );

    expect(duringStream.every((n) => n === 0)).toBe(true);
    expect(countOf(dispatcher, "bash")).toBe(1);
  });

  it("FX-RETRY-005 answers every announced call in a mixed turn", async () => {
    // Deferring the write means the in-flight map no longer holds every call.
    // Draining that map alone would drop the write from the turn without a
    // result, which the model would read as the call never having been made.
    const dispatcher = new CountingDispatcher(registry(READ, WRITE));
    const events = await collect(
      engineWith(
        retriedTurn([
          { id: "r1", name: "read", input: { path: "/tmp/a" } },
          { id: "w1", name: "write", input: { path: "/tmp/b", content: "x" } },
        ]),
      ).run(config({ dispatcher: dispatcher as unknown as ToolDispatcher })),
    );

    const results = events.filter((e) => e.type === "tool_result") as Array<
      Extract<NormalizedEvent, { type: "tool_result" }>
    >;
    expect(results.map((r) => r.toolUseId)).toEqual(["r1", "w1"]);
    expect(countOf(dispatcher, "write")).toBe(1);
  });

  it("FX-RETRY-006 keeps two identical mutating calls as two operations", async () => {
    // `echo x >> log` twice is two appends. Collapsing them by argument
    // equality would silently drop the second one on every turn.
    const dispatcher = new CountingDispatcher(registry(OPAQUE));
    await collect(
      engineWith(
        retriedTurn([
          { id: "b1", name: "bash", input: { command: "echo x >> log" } },
          { id: "b2", name: "bash", input: { command: "echo x >> log" } },
        ]),
      ).run(config({ dispatcher: dispatcher as unknown as ToolDispatcher })),
    );

    expect(countOf(dispatcher, "bash")).toBe(2);
  });

  it("FX-RETRY-007 reports a refused call rather than silently skipping it", async () => {
    // A suppressed duplicate that produced no result would leave the model with
    // a tool_use it never got an answer to.
    const dispatcher = new CountingDispatcher(registry(WRITE));
    const events = await collect(
      engineWith(
        retriedTurn([{ id: "c1", name: "write", input: { path: "/tmp/f", content: "x" } }]),
      ).run(config({ dispatcher: dispatcher as unknown as ToolDispatcher })),
    );

    const results = events.filter((e) => e.type === "tool_result") as Array<
      Extract<NormalizedEvent, { type: "tool_result" }>
    >;
    expect(results).toHaveLength(1);
    expect(results[0]!.toolUseId).toBe("c1");
  });

  it("FX-RETRY-008 gates a deferred call exactly once", async () => {
    // The gate is skipped during streaming for anything not speculated on, so
    // the deferred path has to run it — once, not never and not twice.
    const gated: string[] = [];
    const dispatcher = new CountingDispatcher(registry(WRITE));
    await collect(
      engineWith(
        retriedTurn([{ id: "c1", name: "write", input: { path: "/tmp/f", content: "x" } }]),
      ).run(
        config({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          canUseTool: async (name) => {
            gated.push(name);
            return { allow: true } as PermissionDecision;
          },
        }),
      ),
    );

    expect(gated.filter((n) => n === "write")).toHaveLength(1);
  });
});

describe("a cancelled turn", () => {
  it("FX-RETRY-009 waits for work already under way before returning", async () => {
    // Returning while a tool is still running reports a cancellation that has
    // not happened: the effect lands afterwards, into a turn everyone believes
    // is over.
    const dispatcher = new CountingDispatcher(registry(READ), { delayMs: 120 });
    const ac = new AbortController();
    let finishedAt = 0;
    const started = Date.now();

    const provider = new ScriptedProvider(
      [
        [
          { type: "tool-call", id: "r1", name: "read", input: { path: "/tmp/a" } },
          { type: "text-delta", text: "more" },
          { type: "finish", stopReason: "tool_use", usage: USAGE },
        ],
      ],
      new Map(),
      async () => {
        // Cancel once the read is under way.
        await new Promise((r) => setImmediate(r));
        if (dispatcher.dispatched.length > 0) ac.abort();
      },
    );

    const engine = engineWith(provider);
    await collect(
      engine.run(
        config({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          abort: ac.signal,
        }),
      ),
    );
    finishedAt = Date.now() - started;

    expect(dispatcher.dispatched.length).toBe(1);
    // The read takes 120ms; returning materially sooner means it was abandoned.
    expect(finishedAt).toBeGreaterThanOrEqual(100);
    // It settled, so there is nothing unaccounted for.
    expect(engine.unresolvedOperations()).toEqual([]);
  });

  it("FX-RETRY-010 records an operation that never reports as outcome_unknown", async () => {
    // A tool that ignores its abort signal must not hold cancellation open, and
    // the resulting uncertainty must survive the turn rather than be discarded.
    const dispatcher = new CountingDispatcher(registry(READ), { hang: "read" });
    const ac = new AbortController();

    const provider = new ScriptedProvider(
      [
        [
          { type: "tool-call", id: "r1", name: "read", input: { path: "/tmp/a" } },
          { type: "text-delta", text: "more" },
          { type: "finish", stopReason: "tool_use", usage: USAGE },
        ],
      ],
      new Map(),
      async () => {
        await new Promise((r) => setImmediate(r));
        if (dispatcher.dispatched.length > 0) ac.abort();
      },
    );

    const engine = engineWith(provider, { cancellationGraceMs: 50 });
    await collect(
      engine.run(
        config({
          dispatcher: dispatcher as unknown as ToolDispatcher,
          abort: ac.signal,
        }),
      ),
    );

    const unresolved = engine.unresolvedOperations();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({ kind: "outcome_unknown" });
    expect(unresolved[0]!.kind === "outcome_unknown" && unresolved[0]!.reason).toContain(
      "cancelled",
    );
  });
});
