/**
 * CodexAppServerProvider — Stage 4H dynamicTools tests.
 *
 * Validates the protocol round-trip for host-side tool registration:
 *   1. initialize sends `capabilities.experimentalApi: true` when
 *      dynamicTools are configured.
 *   2. thread/start includes the `dynamicTools` array.
 *   3. Incoming `item/tool/call` JSON-RPC requests dispatch to the
 *      configured handler and the result is written back as a JSON-RPC
 *      success response with the same `id`.
 *   4. Errors in the handler are surfaced as `{success: false}` rather
 *      than crashing the dispatch loop.
 *
 * The fixture-replay test reads the captured 129-frame trace from Track B
 * (test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl) and asserts
 * the protocol contract end-to-end.
 *
 * Pattern mirrors src/providers/codex-app-server.test.ts — fake ChildProcess
 * built from PassThrough streams; the real `codex` binary is never spawned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { CodexAppServerProvider } from "./codex-app-server.js";
import type { DynamicToolCallHandler } from "./codex-app-server.js";
import type { Tool } from "./codex-app-server-types.js";

// ---------------------------------------------------------------------------
// Fake ChildProcess factory (same shape as codex-app-server.test.ts)
// ---------------------------------------------------------------------------

interface FakeChildPair {
  child: ChildProcess;
  /** Lines the client wrote to stdin (one entry per `\n`-terminated frame). */
  readonly written: string[];
  /** Push a raw JSON-RPC frame as if the server wrote it to stdout. */
  emitLine: (frame: object) => void;
  /** Push a raw line (e.g. fixture line that's already a JSON string). */
  emitRaw: (line: string) => void;
}

function makeFakeChild(): FakeChildPair {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();

  const written: string[] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const p of parts) {
      if (p.length > 0) written.push(p);
    }
  });

  const child = Object.assign(emitter, {
    stdout,
    stdin,
    stderr: null,
    pid: 99999,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal?: string) => {
      emitter.emit("close", null, signal ?? null);
    }),
  }) as unknown as ChildProcess;

  function emitLine(frame: object): void {
    stdout.push(JSON.stringify(frame) + "\n");
  }

  function emitRaw(line: string): void {
    stdout.push(line + "\n");
  }

  return { child, written, emitLine, emitRaw };
}

function makeSpawnMock(child: ChildProcess) {
  return vi.fn(
    (
      _cmd: string,
      _args?: readonly string[],
      _opts?: object,
    ): ChildProcess => child,
  );
}

/** Wait for the next microtask tick to flush listeners. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Schema-shape unit tests
// ---------------------------------------------------------------------------

describe("CodexAppServerProvider — dynamicTools handshake", () => {
  let pair: FakeChildPair;
  let spawnMock: ReturnType<typeof makeSpawnMock>;

  beforeEach(() => {
    pair = makeFakeChild();
    spawnMock = makeSpawnMock(pair.child);
  });

  it("constructor throws when dynamicTools is non-empty without onDynamicToolCall", () => {
    expect(() => {
      new CodexAppServerProvider({
        dynamicTools: [{ name: "swarm_ping", inputSchema: {} } as Tool],
        spawn: spawnMock as never,
      });
    }).toThrow(/onDynamicToolCall/);
  });

  it("initialize sends capabilities.experimentalApi=true when dynamicTools is non-empty", async () => {
    const handler = vi.fn();
    const provider = new CodexAppServerProvider({
      dynamicTools: [{ name: "swarm_ping", inputSchema: {} } as Tool],
      onDynamicToolCall: handler as unknown as DynamicToolCallHandler,
      spawn: spawnMock as never,
    });

    const startPromise = provider.start();
    await flush();

    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    const initFrame = pair.written
      .map((l) => JSON.parse(l))
      .find((f) => f.method === "initialize");
    expect(initFrame).toBeDefined();
    expect(initFrame.params.capabilities).toEqual({ experimentalApi: true });

    await provider.dispose();
  });

  it("initialize keeps capabilities=null when no dynamicTools are configured (back-compat)", async () => {
    const provider = new CodexAppServerProvider({ spawn: spawnMock as never });

    const startPromise = provider.start();
    await flush();
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    const initFrame = pair.written
      .map((l) => JSON.parse(l))
      .find((f) => f.method === "initialize");
    expect(initFrame).toBeDefined();
    expect(initFrame.params.capabilities).toBeNull();

    await provider.dispose();
  });

  it("thread/start request includes dynamicTools array", async () => {
    const handler = vi.fn();
    const tools: Tool[] = [
      {
        name: "swarm_ping",
        description: "echo content back as pong:<content>",
        inputSchema: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
      },
    ];

    const provider = new CodexAppServerProvider({
      dynamicTools: tools,
      onDynamicToolCall: handler as unknown as DynamicToolCallHandler,
      spawn: spawnMock as never,
    });

    const startPromise = provider.start();
    await flush();
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    const threadPromise = provider.startThread();
    await flush();

    const threadStartFrame = pair.written
      .map((l) => JSON.parse(l))
      .find((f) => f.method === "thread/start");
    expect(threadStartFrame).toBeDefined();
    expect(threadStartFrame.params.dynamicTools).toEqual(tools);

    pair.emitLine({
      id: threadStartFrame.id,
      result: {
        thread: {
          id: "t-1",
          preview: "",
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          cwd: "/",
          turns: [],
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: null,
      },
    });
    await threadPromise;
    await provider.dispose();
  });
});

// ---------------------------------------------------------------------------
// Inbound item/tool/call request dispatch
// ---------------------------------------------------------------------------

describe("CodexAppServerProvider — item/tool/call dispatch", () => {
  let pair: FakeChildPair;
  let spawnMock: ReturnType<typeof makeSpawnMock>;

  beforeEach(() => {
    pair = makeFakeChild();
    spawnMock = makeSpawnMock(pair.child);
  });

  /** Boot a provider with one tool wired to `handler`. */
  async function bootWithHandler(
    handler: ReturnType<typeof vi.fn>,
  ): Promise<CodexAppServerProvider> {
    const provider = new CodexAppServerProvider({
      dynamicTools: [
        {
          name: "swarm_ping",
          inputSchema: { type: "object" },
        } as Tool,
      ],
      onDynamicToolCall: handler as unknown as DynamicToolCallHandler,
      spawn: spawnMock as never,
    });
    const startPromise = provider.start();
    await flush();
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;
    return provider;
  }

  it("invokes the registered handler with parsed params and writes a result frame", async () => {
    const handler = vi.fn().mockResolvedValue({
      contentItems: [{ type: "inputText", text: "pong:hello" }],
      success: true,
    });
    const provider = await bootWithHandler(handler);

    pair.written.length = 0;

    pair.emitRaw(
      JSON.stringify({
        method: "item/tool/call",
        id: 0,
        params: {
          threadId: "thr-1",
          turnId: "tur-1",
          callId: "call-xyz",
          tool: "swarm_ping",
          arguments: { content: "hello" },
        },
      }),
    );
    // Allow the async handler to resolve and the response to be written.
    await flush();
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toBe("swarm_ping");
    expect(handler.mock.calls[0]![1]).toEqual({ content: "hello" });
    expect(handler.mock.calls[0]![2]).toEqual({
      threadId: "thr-1",
      turnId: "tur-1",
      callId: "call-xyz",
    });

    expect(pair.written).toHaveLength(1);
    const responseFrame = JSON.parse(pair.written[0]!);
    expect(responseFrame).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: {
        contentItems: [{ type: "inputText", text: "pong:hello" }],
        success: true,
      },
    });

    await provider.dispose();
  });

  it("returns success=false response when handler throws (does not crash dispatch loop)", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("kaboom"));
    const provider = await bootWithHandler(handler);

    pair.written.length = 0;

    pair.emitRaw(
      JSON.stringify({
        method: "item/tool/call",
        id: 7,
        params: {
          threadId: "thr-1",
          turnId: "tur-1",
          callId: "call-x",
          tool: "swarm_ping",
          arguments: {},
        },
      }),
    );
    await flush();
    await flush();

    expect(pair.written).toHaveLength(1);
    const frame = JSON.parse(pair.written[0]!);
    expect(frame.id).toBe(7);
    expect(frame.result.success).toBe(false);
    expect(frame.result.contentItems[0].text).toContain("kaboom");

    await provider.dispose();
  });

  it("returns success=false when item/tool/call params fail validation", async () => {
    const handler = vi.fn();
    const provider = await bootWithHandler(handler);

    pair.written.length = 0;

    pair.emitRaw(
      JSON.stringify({
        method: "item/tool/call",
        id: 9,
        params: { tool: "swarm_ping" /* missing threadId/turnId/callId/arguments */ },
      }),
    );
    await flush();
    await flush();

    expect(handler).not.toHaveBeenCalled();
    const frame = JSON.parse(pair.written[0]!);
    expect(frame.id).toBe(9);
    expect(frame.result.success).toBe(false);

    await provider.dispose();
  });

  it("ignores v1 codex/event/dynamic_tool_call_request notification (uses v2 only)", async () => {
    const handler = vi.fn();
    const provider = await bootWithHandler(handler);

    pair.written.length = 0;
    // The v1 wrapper is a notification (no id) — must NOT be dispatched.
    pair.emitLine({
      method: "codex/event/dynamic_tool_call_request",
      params: {
        id: "0",
        msg: {
          type: "dynamic_tool_call_request",
          callId: "ignored",
          turnId: "0",
          tool: "swarm_ping",
          arguments: {},
        },
      },
    });
    await flush();
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(pair.written).toHaveLength(0);

    await provider.dispose();
  });

  it("replies with JSON-RPC error for unknown server-originated methods", async () => {
    const handler = vi.fn();
    const provider = await bootWithHandler(handler);

    pair.written.length = 0;
    pair.emitRaw(
      JSON.stringify({
        method: "unknown/method",
        id: 42,
        params: {},
      }),
    );
    await flush();

    expect(pair.written).toHaveLength(1);
    const frame = JSON.parse(pair.written[0]!);
    expect(frame.id).toBe(42);
    expect(frame.error).toBeDefined();
    expect(frame.error.code).toBe(-32601);

    await provider.dispose();
  });
});

// ---------------------------------------------------------------------------
// Captured-trace replay (full protocol round-trip)
// ---------------------------------------------------------------------------

interface FixtureFrame {
  ts: number;
  direction: string;
  message: Record<string, unknown>;
}

function loadFixture(): FixtureFrame[] {
  const p = join(
    process.cwd(),
    "test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl",
  );
  const text = readFileSync(p, "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as FixtureFrame);
}

describe("CodexAppServerProvider — fixture replay (Track B captured trace)", () => {
  let pair: FakeChildPair;
  let spawnMock: ReturnType<typeof makeSpawnMock>;

  beforeEach(() => {
    pair = makeFakeChild();
    spawnMock = makeSpawnMock(pair.child);
  });

  it("replays the 129-frame trace and round-trips item/tool/call to a handler", async () => {
    const fixture = loadFixture();
    expect(fixture.length).toBeGreaterThan(0);

    // Spike fixture registers `swarm_ping` and expects pong:<content> back.
    const handler = vi.fn(
      async (
        tool: string,
        args: unknown,
        _ctx: { threadId: string; turnId: string; callId: string },
      ) => {
        const a = args as { content?: string };
        return {
          contentItems: [
            {
              type: "inputText" as const,
              text: tool === "swarm_ping" ? `pong:${a.content ?? ""}` : "?",
            },
          ],
          success: true,
        };
      },
    );

    const provider = new CodexAppServerProvider({
      dynamicTools: [
        {
          name: "swarm_ping",
          description: "A test tool that echoes 'pong:<content>' back.",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
            additionalProperties: false,
          },
        },
      ],
      onDynamicToolCall: handler as unknown as DynamicToolCallHandler,
      spawn: spawnMock as never,
    });

    const startPromise = provider.start();
    await flush();

    // Walk the fixture in order. For server→client frames replay them onto
    // stdout. For client→server frames just advance — we'll cross-check
    // ours against the fixture as a sanity probe.
    const serverFrames = fixture.filter((f) => f.direction.startsWith("server"));
    const clientFrames = fixture.filter((f) => f.direction.startsWith("client"));

    // Index server responses by id (`{id, result}` shape).
    const respondersById = new Map<number, FixtureFrame>();
    for (const sf of serverFrames) {
      const m = sf.message;
      if (typeof m["id"] === "number" && "result" in m) {
        respondersById.set(m["id"] as number, sf);
      }
    }

    // 1) initialize (id=1) — replay the response and confirm our request.
    pair.emitLine(respondersById.get(1)!.message);
    await startPromise;

    const initOut = pair.written.map((l) => JSON.parse(l));
    const ourInit = initOut.find((f) => f.method === "initialize");
    expect(ourInit.params.capabilities).toEqual({ experimentalApi: true });

    // 2) thread/start — drive it; ensure dynamicTools is sent.
    const threadPromise = provider.startThread({
      model: "gpt-5.4",
      cwd: "/Users/alexngai/GitHub/openswarm",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    await flush();
    const ourThread = pair.written.map((l) => JSON.parse(l)).find((f) => f.method === "thread/start");
    expect(ourThread.params.dynamicTools).toBeDefined();
    expect(ourThread.params.dynamicTools).toHaveLength(1);
    expect(ourThread.params.dynamicTools[0].name).toBe("swarm_ping");

    pair.emitLine(respondersById.get(2)!.message);
    const threadResult = await threadPromise;
    expect(threadResult.threadId).toBe("019deacd-1d99-7b02-87f3-5c440b0a8087");

    // 3) Replay the rest of the trace — every server-side frame in fixture
    //    order, except the two responses already replayed (ids 1 and 2).
    //    Use emitRaw so notifications, server-requests, and responses are
    //    each parsed by the same dispatchLine path the real transport uses.
    pair.written.length = 0;

    for (const sf of serverFrames) {
      const m = sf.message;
      if (m["id"] === 1 || m["id"] === 2 || m["id"] === 4) continue;
      pair.emitRaw(JSON.stringify(m));
    }
    // Allow handler microtasks + writes to flush.
    await flush();
    await flush();
    await flush();

    // 4) Verify the handler was invoked exactly once for the swarm_ping
    //    item/tool/call (id=0 in the fixture) with the expected args.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toBe("swarm_ping");
    expect(handler.mock.calls[0]![1]).toEqual({ content: "hello" });
    expect(handler.mock.calls[0]![2]).toEqual({
      threadId: "019deacd-1d99-7b02-87f3-5c440b0a8087",
      turnId: "0",
      callId: "call_XAjMVufWEhTRqwy18YRqMcTb",
    });

    // 5) Verify the response written to stdin matches the fixture's
    //    captured client→server response (id=0, contentItems=[pong:hello]).
    const responseFrames = pair.written
      .map((l) => JSON.parse(l))
      .filter((f) => f.id === 0 && "result" in f);
    expect(responseFrames).toHaveLength(1);
    const expectedResponse = clientFrames.find(
      (cf) =>
        typeof cf.message["id"] === "number" &&
        cf.message["id"] === 0 &&
        "result" in cf.message,
    );
    expect(expectedResponse).toBeDefined();
    expect(responseFrames[0].result).toEqual(
      (expectedResponse!.message as { result: unknown }).result,
    );

    await provider.dispose();
  });
});
