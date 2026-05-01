/**
 * CodexAppServerProvider — unit tests (Stage 3A + 3B).
 *
 * All tests use a fake ChildProcess (PassThrough streams + EventEmitter) so
 * the real `codex` binary is never spawned. Pattern mirrors
 * src/swarm/standalone-host.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { CodexAppServerProvider } from "./codex-app-server.js";
import type { JsonRpcNotification } from "./codex-app-server-types.js";
import type { NormalizedEvent } from "../core/types.js";

// ---------------------------------------------------------------------------
// Fake ChildProcess factory
// ---------------------------------------------------------------------------

interface FakeChildPair {
  child: ChildProcess;
  /** Push a JSON-RPC frame as if the server wrote it to stdout. */
  emitLine: (frame: object) => void;
}

function makeFakeChild(): FakeChildPair {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();

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

  return { child, emitLine };
}

/** Build a spawn mock that returns a pre-built fake child. */
function makeSpawnMock(child: ChildProcess) {
  return vi.fn(
    (
      _cmd: string,
      _args?: readonly string[],
      _opts?: object,
    ): ChildProcess => child,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexAppServerProvider", () => {
  let pair: FakeChildPair;
  let spawnMock: ReturnType<typeof makeSpawnMock>;

  beforeEach(() => {
    pair = makeFakeChild();
    spawnMock = makeSpawnMock(pair.child);
  });

  // -------------------------------------------------------------------------
  // Test 1: start() sends initialize and resolves with user-agent
  // -------------------------------------------------------------------------

  it("start() sends initialize and resolves with user-agent", async () => {
    const provider = new CodexAppServerProvider({ spawn: spawnMock as never });

    const startPromise = provider.start();

    // Let the provider wire up the stdout listener before emitting.
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({ id: 1, result: { userAgent: "test-ua" } });

    const result = await startPromise;
    expect(result).toEqual({ userAgent: "test-ua" });

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 2: start() spawns the right binary + args
  // -------------------------------------------------------------------------

  it("start() spawns the right binary + args", async () => {
    const provider = new CodexAppServerProvider({ spawn: spawnMock as never });

    const startPromise = provider.start();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("codex");
    expect(args).toEqual(["app-server"]);
    expect((opts as { stdio: unknown }).stdio).toEqual(["pipe", "pipe", "inherit"]);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3: getAuthStatus parses authMethod field
  // -------------------------------------------------------------------------

  it("getAuthStatus parses authMethod field", async () => {
    const provider = new CodexAppServerProvider({ spawn: spawnMock as never });

    // Boot the provider (initialize handshake).
    const startPromise = provider.start();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    // Issue getAuthStatus and reply.
    const authPromise = provider.getAuthStatus();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({
      id: 2,
      result: { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true },
    });

    const status = await authPromise;
    expect(status.authMethod).toBe("chatgpt");
    expect(status.requiresOpenaiAuth).toBe(true);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 4: Notifications fire on the notification event
  // -------------------------------------------------------------------------

  it("Notifications fire on the notification event", async () => {
    const provider = new CodexAppServerProvider({ spawn: spawnMock as never });

    const startPromise = provider.start();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    const received: JsonRpcNotification[] = [];
    provider.on("notification", (frame: JsonRpcNotification) => {
      received.push(frame);
    });

    pair.emitLine({ method: "thread/started", params: { threadId: "abc" } });
    // Flush microtasks so the data event propagates.
    await new Promise<void>((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("thread/started");

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 5: dispose() closes stdin and waits for process exit
  // -------------------------------------------------------------------------

  it("dispose() closes stdin and waits for process exit", async () => {
    const provider = new CodexAppServerProvider({ spawn: spawnMock as never });

    const startPromise = provider.start();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    const stdinEndSpy = vi.spyOn(pair.child.stdin!, "end");

    // dispose() should not resolve until the 'close' event fires.
    let disposed = false;
    const disposePromise = provider.dispose().then(() => {
      disposed = true;
    });

    // Give dispose a tick to call stdin.end() and register the close listener.
    await new Promise<void>((r) => setImmediate(r));

    expect(stdinEndSpy).toHaveBeenCalled();
    // Not yet resolved — waiting for close.
    expect(disposed).toBe(false);

    // Simulate the child process exiting.
    pair.child.emit("close", 0, null);

    await disposePromise;
    expect(disposed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 6: JSON-RPC error responses reject the pending request promise
  // -------------------------------------------------------------------------

  it("JSON-RPC error responses reject the pending request promise", async () => {
    const provider = new CodexAppServerProvider({ spawn: spawnMock as never });

    const startPromise = provider.start();
    await new Promise<void>((r) => setImmediate(r));

    // Respond to initialize with a JSON-RPC error.
    pair.emitLine({
      id: 1,
      error: { code: -32600, message: "Invalid Request" },
    });

    await expect(startPromise).rejects.toThrow("Invalid Request");

    pair.child.emit("close", 1, null);
  });

  // -------------------------------------------------------------------------
  // Test 7: codexBinary opt allows custom binary path
  // -------------------------------------------------------------------------

  it("codexBinary opt allows custom binary path", async () => {
    const customPath = "/custom/path/to/codex";
    const provider = new CodexAppServerProvider({
      codexBinary: customPath,
      spawn: spawnMock as never,
    });

    const startPromise = provider.start();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 1, result: { userAgent: "ua" } });
    await startPromise;

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]![0]).toBe(customPath);

    await provider.dispose();
  });
});

// ---------------------------------------------------------------------------
// Stage 3B tests
// ---------------------------------------------------------------------------

/** Helper: boot provider through initialize handshake. Returns booted provider. */
async function bootProvider(pair: FakeChildPair, spawnMock: ReturnType<typeof makeSpawnMock>) {
  const provider = new CodexAppServerProvider({ spawn: spawnMock as never });
  const startPromise = provider.start();
  await new Promise<void>((r) => setImmediate(r));
  pair.emitLine({ id: 1, result: { userAgent: "ua" } });
  await startPromise;
  return provider;
}

describe("CodexAppServerProvider — Stage 3B", () => {
  let pair: FakeChildPair;
  let spawnMock: ReturnType<typeof makeSpawnMock>;

  beforeEach(() => {
    pair = makeFakeChild();
    spawnMock = makeSpawnMock(pair.child);
  });

  // -------------------------------------------------------------------------
  // Test 3B-1: startThread returns threadId from thread/start response
  // -------------------------------------------------------------------------

  it("startThread returns threadId from thread/start response", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const threadPromise = provider.startThread({ model: "gpt-5.4" });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({
      id: 2,
      result: {
        thread: {
          id: "thread-abc-123",
          preview: "",
          modelProvider: "openai",
          createdAt: 1234,
          updatedAt: 1234,
          cwd: "/tmp",
          turns: [],
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/tmp",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: null,
      },
    });

    const result = await threadPromise;
    expect(result.threadId).toBe("thread-abc-123");
    expect(result.model).toBe("gpt-5.4");

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-2: runTurn sends turn/start with the right shape
  // -------------------------------------------------------------------------

  it("runTurn sends turn/start with the right shape", async () => {
    const provider = await bootProvider(pair, spawnMock);

    // Capture what gets written to stdin.
    const written: string[] = [];
    pair.child.stdin!.on("data", (chunk: Buffer | string) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    // Start the turn — drain asynchronously in background.
    const gen = provider.runTurn("thread-xyz", "Hello world", { model: "gpt-5.4" });
    const drainPromise = (async () => { for await (const _ of gen) { /* drain */ } })();

    await new Promise<void>((r) => setImmediate(r));

    // Find the turn/start request in written data.
    const allWritten = written.join("");
    const lines = allWritten.split("\n").filter(Boolean);
    const turnStartLine = lines.find((l) => l.includes('"turn/start"'));
    expect(turnStartLine).toBeDefined();
    const frame = JSON.parse(turnStartLine!);
    expect(frame.method).toBe("turn/start");
    expect(frame.params.threadId).toBe("thread-xyz");
    expect(frame.params.input).toEqual([{ type: "text", text: "Hello world" }]);
    expect(frame.params.model).toBe("gpt-5.4");

    // Send turn/start response + complete the turn so the generator finishes.
    pair.emitLine({ id: frame.id, result: { turn: { id: "0", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({
      method: "turn/completed",
      params: { threadId: "thread-xyz", turn: { id: "0", items: [], status: "completed", error: null } },
    });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-3: runTurn emits text_delta for item/agentMessage/delta
  // -------------------------------------------------------------------------

  it("runTurn emits text_delta events for each item/agentMessage/delta notification", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));

    // Respond to turn/start (id:2).
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Send two deltas.
    pair.emitLine({ method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "turn1", itemId: "item1", delta: "Hello " } });
    pair.emitLine({ method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "turn1", itemId: "item1", delta: "world" } });
    await new Promise<void>((r) => setImmediate(r));

    // Complete the turn.
    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    const deltas = events.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
    expect(deltas).toHaveLength(2);
    expect(deltas[0]!.text).toBe("Hello ");
    expect(deltas[1]!.text).toBe("world");

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-4: runTurn emits message_stop with stopReason='end_turn'
  // -------------------------------------------------------------------------

  it("runTurn emits message_stop with stopReason='end_turn' when turn/completed status='completed'", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    expect((stop as { type: "message_stop"; stopReason: string }).stopReason).toBe("end_turn");

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-5: runTurn emits error event when turn/completed status='failed'
  // -------------------------------------------------------------------------

  it("runTurn emits error event when turn/completed status='failed'", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({
      method: "turn/completed",
      params: {
        threadId: "t1",
        turn: { id: "turn1", items: [], status: "failed", error: { message: "HTTP 402: quota exceeded" } },
      },
    });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: "error"; error: { message: string } }).error.message).toContain("402");

    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    expect((stop as { type: "message_stop"; stopReason: string }).stopReason).toBe("error");

    // error must come before message_stop
    const errorIdx = events.indexOf(errorEvent!);
    const stopIdx = events.indexOf(stop!);
    expect(errorIdx).toBeLessThan(stopIdx);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-6: runTurn skips reasoning items
  // -------------------------------------------------------------------------

  it("runTurn skips reasoning items", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Emit reasoning item/started + item/completed — should produce no events.
    pair.emitLine({
      method: "item/started",
      params: {
        item: { type: "reasoning", id: "rs_123", summary: [], content: [] },
        threadId: "t1",
        turnId: "turn1",
      },
    });
    pair.emitLine({
      method: "item/completed",
      params: {
        item: { type: "reasoning", id: "rs_123", summary: [], content: [] },
        threadId: "t1",
        turnId: "turn1",
      },
    });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    // reasoning items fall through to info events; only tool/text events should be absent.
    const nonStopNonInfo = events.filter((e) => e.type !== "message_stop" && e.type !== "info");
    expect(nonStopNonInfo).toHaveLength(0);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-7: runTurn aborts via signal — sends turn/interrupt, emits error
  // -------------------------------------------------------------------------

  it("runTurn aborts via signal — sends turn/interrupt and emits error event", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const controller = new AbortController();

    // Capture stdin writes to verify turn/interrupt is sent.
    const written: string[] = [];
    pair.child.stdin!.on("data", (chunk: Buffer | string) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    const gen = provider.runTurn("t1", "prompt", { signal: controller.signal });
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));

    // Respond to turn/start so streaming begins.
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Abort mid-stream.
    controller.abort();
    await new Promise<void>((r) => setImmediate(r));

    // Allow turn/interrupt request to resolve (respond with ok).
    const allWritten = written.join("");
    const interruptLine = allWritten.split("\n").find((l) => l.includes('"turn/interrupt"'));
    if (interruptLine) {
      const frame = JSON.parse(interruptLine);
      pair.emitLine({ id: frame.id, result: { ok: true } });
    }

    await new Promise<void>((r) => setImmediate(r));
    await drainPromise;

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: "error"; error: { message: string } }).error.message).toContain("abort");

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-8: getCumulativeUsage aggregates token counts
  // -------------------------------------------------------------------------

  it("getCumulativeUsage aggregates token counts from thread/tokenUsage/updated", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const drainPromise = (async () => { for await (const _ of gen) { /* drain */ } })();

    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Emit a tokenUsage notification.
    pair.emitLine({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t1",
        turnId: "turn1",
        tokenUsage: {
          total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 60, outputTokens: 20, reasoningOutputTokens: 5 },
          last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 60, outputTokens: 20, reasoningOutputTokens: 5 },
          modelContextWindow: 258400,
        },
      },
    });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    const usage = provider.getCumulativeUsage();
    expect(usage.inputTokens).toBe(80);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cacheReadInputTokens).toBe(60);
    expect(usage.cacheWriteInputTokens).toBe(0);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-D1: abort mid-stream then immediately start second turn — no
  // stale data from first turn corrupts the second (Defect 1).
  // -------------------------------------------------------------------------

  it("abort mid-stream: second runTurn is not corrupted by stale first-turn data", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const controller = new AbortController();

    // First turn — start it, then abort before turn/completed arrives.
    const gen1 = provider.runTurn("t1", "first", { signal: controller.signal });
    const events1: NormalizedEvent[] = [];
    const drain1 = (async () => {
      for await (const ev of gen1) events1.push(ev);
    })();

    await new Promise<void>((r) => setImmediate(r));
    // Respond to turn/start (id:2).
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Abort the first turn.
    controller.abort();
    await new Promise<void>((r) => setImmediate(r));

    // Respond to the turn/interrupt request (id:3) that abort sends, so its
    // pending entry is resolved and doesn't linger in the map.
    pair.emitLine({ id: 3, result: { ok: true } });
    await new Promise<void>((r) => setImmediate(r));
    await drain1;

    const errorEvent1 = events1.find((e) => e.type === "error");
    expect(errorEvent1).toBeDefined();

    // Now immediately start a second turn on the same provider.
    const gen2 = provider.runTurn("t1", "second");
    const events2: NormalizedEvent[] = [];
    const drain2 = (async () => {
      for await (const ev of gen2) events2.push(ev);
    })();

    await new Promise<void>((r) => setImmediate(r));
    // turn/interrupt consumed id:3, so turn/start for turn2 gets id:4.
    pair.emitLine({ id: 4, result: { turn: { id: "turn2", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Emit a late turn/completed for the FIRST turn — should be ignored by turn2.
    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Emit a delta for turn2 — should arrive normally.
    pair.emitLine({ method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "turn2", itemId: "i1", delta: "ok" } });
    await new Promise<void>((r) => setImmediate(r));

    // Complete turn2 properly.
    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn2", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drain2;

    // turn2 should have received the delta and message_stop, NOT a spurious done from turn1.
    const deltas2 = events2.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
    expect(deltas2).toHaveLength(1);
    expect(deltas2[0]!.text).toBe("ok");
    const stop2 = events2.find((e) => e.type === "message_stop");
    expect(stop2).toBeDefined();

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-D3: child crash mid-stream — iterator yields error then ends
  // (Defect 3).
  // -------------------------------------------------------------------------

  it("child crash mid-stream: runTurn yields transport error then ends", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];
    const drain = (async () => {
      for await (const ev of gen) events.push(ev);
    })();

    await new Promise<void>((r) => setImmediate(r));
    // turn/start response.
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Kill the child process unexpectedly (emit close without dispose).
    pair.child.emit("close", 1, null);
    await new Promise<void>((r) => setImmediate(r));

    await drain;

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(
      (errorEvent as { type: "error"; error: { message: string } }).error.message,
    ).toContain("exited unexpectedly");
    // Iterator must have ended (drain completed).
  });

  // -------------------------------------------------------------------------
  // Test 3B-D5: message_stop.usage is per-turn delta, not cumulative
  // (Defect 5).
  // -------------------------------------------------------------------------

  it("message_stop.usage reports per-turn delta, not session cumulative", async () => {
    const provider = await bootProvider(pair, spawnMock);

    // Turn 1: 80 input, 20 output tokens.
    const gen1 = provider.runTurn("t1", "prompt1");
    const events1: NormalizedEvent[] = [];
    const drain1 = (async () => { for await (const ev of gen1) events1.push(ev); })();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t1", turnId: "turn1",
        tokenUsage: {
          total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
          last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
          modelContextWindow: 258400,
        },
      },
    });
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));
    await drain1;

    const stop1 = events1.find((e) => e.type === "message_stop") as { type: "message_stop"; usage: { inputTokens: number; outputTokens: number } } | undefined;
    expect(stop1).toBeDefined();
    // Per-turn delta for turn1: 80 in, 20 out.
    expect(stop1!.usage.inputTokens).toBe(80);
    expect(stop1!.usage.outputTokens).toBe(20);

    // Turn 2: 40 more input, 10 more output tokens.
    const gen2 = provider.runTurn("t1", "prompt2");
    const events2: NormalizedEvent[] = [];
    const drain2 = (async () => { for await (const ev of gen2) events2.push(ev); })();
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 3, result: { turn: { id: "turn2", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t1", turnId: "turn2",
        tokenUsage: {
          total: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          last: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          modelContextWindow: 258400,
        },
      },
    });
    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn2", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));
    await drain2;

    const stop2 = events2.find((e) => e.type === "message_stop") as { type: "message_stop"; usage: { inputTokens: number; outputTokens: number } } | undefined;
    expect(stop2).toBeDefined();
    // Per-turn delta for turn2 only: 40 in, 10 out (not cumulative 120/30).
    expect(stop2!.usage.inputTokens).toBe(40);
    expect(stop2!.usage.outputTokens).toBe(10);

    // Cumulative stays at 120 in, 30 out.
    const cumulative = provider.getCumulativeUsage();
    expect(cumulative.inputTokens).toBe(120);
    expect(cumulative.outputTokens).toBe(30);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-9: Fixture replay — handshake-and-turn.jsonl
  // -------------------------------------------------------------------------

  it("Replay against handshake-and-turn.jsonl: emits text_delta('DONE') and message_stop", async () => {
    const fixturePath = join(
      __dirname,
      "../../test/fixtures/codex-app-server/handshake-and-turn.jsonl",
    );
    const lines = readFileSync(fixturePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { ts: number; direction: string; message: Record<string, unknown> });

    // We replay only server→client notifications (no `id` field = notification).
    const serverNotifications = lines.filter(
      (l) =>
        l.direction === "server→client" &&
        typeof l.message["method"] === "string" &&
        !("id" in l.message),
    );

    // The captured threadId and turnId from the fixture.
    const fixtureThreadId = "019de4e6-00dd-7973-a27b-a029d4ac36ef";

    const provider = await bootProvider(pair, spawnMock);

    // runTurn expects turn/start response first.
    const gen = provider.runTurn(fixtureThreadId, "Reply with the single word DONE.");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));

    // Reply to turn/start (id:2) with the fixture's captured result.
    pair.emitLine({ id: 2, result: { turn: { id: "0", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Inject all captured server→client notifications in order.
    for (const frame of serverNotifications) {
      pair.emitLine(frame.message);
    }
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    // Verify: at least one text_delta with "DONE".
    const deltas = events.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const fullText = deltas.map((d) => d.text).join("");
    expect(fullText).toBe("DONE");

    // Verify: message_stop with end_turn.
    const stop = events.find((e) => e.type === "message_stop") as
      | { type: "message_stop"; stopReason: string }
      | undefined;
    expect(stop).toBeDefined();
    expect(stop!.stopReason).toBe("end_turn");

    // Verify getCumulativeUsage has been populated from thread/tokenUsage/updated.
    const usage = provider.getCumulativeUsage();
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-N1: unknown notifications produce NormalizedEvent.info
  // -------------------------------------------------------------------------

  it("info event: unknown notifications produce a NormalizedEvent.info with payload preserved", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Emit an unknown notification that has no dedicated handler.
    pair.emitLine({
      method: "thread/started",
      params: { threadId: "t1", someExtra: "data" },
    });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    const infoEvent = events.find((e) => e.type === "info") as
      | { type: "info"; source: string; method: string; payload: unknown }
      | undefined;
    expect(infoEvent).toBeDefined();
    expect(infoEvent!.source).toBe("codex");
    expect(infoEvent!.method).toBe("thread/started");
    expect((infoEvent!.payload as Record<string, unknown>)["someExtra"]).toBe("data");

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-N2: item/started + item/completed for commandExecution emits
  //             tool_use_start + tool_use_input + tool_use_end + tool_result
  // -------------------------------------------------------------------------

  it("tool_use_*: item/started + item/completed for commandExecution produce tool_use_start + tool_use_input + tool_use_end + tool_result", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Emit item/started for a commandExecution item.
    pair.emitLine({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "call_PAE0TiLDxJLcFgyGvdqf16rT",
          command: "/bin/zsh -lc 'ls -1 README.md package.json'",
          cwd: "/Users/alexngai/GitHub/swarm-coder",
          processId: "21323",
          status: "inProgress",
          commandActions: [{ type: "listFiles" }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
        threadId: "t1",
        turnId: "turn1",
      },
    });
    await new Promise<void>((r) => setImmediate(r));

    // Emit item/completed for the same commandExecution item.
    pair.emitLine({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "call_PAE0TiLDxJLcFgyGvdqf16rT",
          command: "/bin/zsh -lc 'ls -1 README.md package.json'",
          cwd: "/Users/alexngai/GitHub/swarm-coder",
          status: "completed",
          commandActions: [{ type: "listFiles" }],
          aggregatedOutput: "README.md\npackage.json\n",
          exitCode: 0,
          durationMs: 51,
        },
        threadId: "t1",
        turnId: "turn1",
      },
    });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    const toolStart = events.find((e) => e.type === "tool_use_start") as
      | { type: "tool_use_start"; id: string; name: string }
      | undefined;
    expect(toolStart).toBeDefined();
    expect(toolStart!.id).toBe("call_PAE0TiLDxJLcFgyGvdqf16rT");
    expect(toolStart!.name).toBe("exec");

    const toolInput = events.find((e) => e.type === "tool_use_input") as
      | { type: "tool_use_input"; id: string; jsonDelta: string }
      | undefined;
    expect(toolInput).toBeDefined();
    expect(toolInput!.id).toBe("call_PAE0TiLDxJLcFgyGvdqf16rT");
    const parsed = JSON.parse(toolInput!.jsonDelta) as { command: string; cwd: string };
    expect(parsed.command).toContain("ls -1");
    expect(parsed.cwd).toContain("swarm-coder");

    const toolEnd = events.find((e) => e.type === "tool_use_end") as
      | { type: "tool_use_end"; id: string }
      | undefined;
    expect(toolEnd).toBeDefined();
    expect(toolEnd!.id).toBe("call_PAE0TiLDxJLcFgyGvdqf16rT");

    const toolResult = events.find((e) => e.type === "tool_result") as
      | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolUseId).toBe("call_PAE0TiLDxJLcFgyGvdqf16rT");
    expect(toolResult!.content).toContain("README.md");
    expect(toolResult!.isError).toBe(false);

    await provider.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3B-N3: failed exec (exitCode !== 0) produces tool_result with isError: true
  // -------------------------------------------------------------------------

  it("tool_use_*: failed exec (exitCode !== 0) produces tool_result with isError: true", async () => {
    const provider = await bootProvider(pair, spawnMock);

    const gen = provider.runTurn("t1", "prompt");
    const events: NormalizedEvent[] = [];

    const drainPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();

    await new Promise<void>((r) => setImmediate(r));
    pair.emitLine({ id: 2, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    // Emit item/completed for a failed commandExecution (exitCode: 1).
    pair.emitLine({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "call_FAIL",
          command: "/bin/zsh -lc 'cat /nonexistent'",
          cwd: "/tmp",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "cat: /nonexistent: No such file or directory",
          exitCode: 1,
          durationMs: 10,
        },
        threadId: "t1",
        turnId: "turn1",
      },
    });
    await new Promise<void>((r) => setImmediate(r));

    pair.emitLine({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", items: [], status: "completed", error: null } } });
    await new Promise<void>((r) => setImmediate(r));

    await drainPromise;

    const toolResult = events.find((e) => e.type === "tool_result") as
      | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolUseId).toBe("call_FAIL");
    expect(toolResult!.isError).toBe(true);
    expect(toolResult!.content).toContain("No such file");

    await provider.dispose();
  });
});
