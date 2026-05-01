/**
 * CodexAppServerProvider — unit tests (Stage 3A skeleton).
 *
 * All tests use a fake ChildProcess (PassThrough streams + EventEmitter) so
 * the real `codex` binary is never spawned. Pattern mirrors
 * src/swarm/standalone-host.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexAppServerProvider } from "./codex-app-server.js";
import type { JsonRpcNotification } from "./codex-app-server-types.js";

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
