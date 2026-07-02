import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { ParentTransport } from "./parent-transport.js";
import { encodeFrame } from "./framing.js";
import { IPC_ERROR_CODES, type IpcRequest } from "./protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ParentTransport wired to controllable PassThrough streams.
 * `stdin`  — test pushes bytes into this (simulates the orchestrator writing)
 * `stdout` — transport writes here (test reads what the worker produced)
 */
function makeTransport(opts?: {
  heartbeatIntervalMs?: number;
  agentId?: string;
  stdout?: Writable;
}) {
  const stdin = new PassThrough();
  const stdout = opts?.stdout ?? new PassThrough();

  const transport = new ParentTransport({
    stdin,
    stdout,
    heartbeatIntervalMs: opts?.heartbeatIntervalMs ?? 30_000,
    agentId: opts?.agentId,
    defaultTimeoutMs: 60_000,
  });

  return { transport, stdin, stdout: stdout as PassThrough };
}

/** Drain all currently buffered bytes from a PassThrough as UTF-8. */
function drain(stream: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while ((chunk = stream.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ParentTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. send() resolves when parent writes a matching response
  it("resolves send() when orchestrator writes a matching response", async () => {
    const { transport, stdin, stdout } = makeTransport();

    const sendPromise = transport.send<{ done: boolean }>("task.create", {
      title: "x",
    });

    // Flush microtasks so the request frame is written.
    await new Promise<void>((r) => setImmediate(r));

    // Read the request frame the transport wrote to its stdout.
    const written = drain(stdout);
    const requestFrame = JSON.parse(written.trim()) as IpcRequest;
    expect(requestFrame.kind).toBe("request");
    expect(requestFrame.method).toBe("task.create");

    // Simulate parent writing a response on stdin.
    stdin.push(
      encodeFrame({
        kind: "response",
        id: requestFrame.id,
        ok: true,
        result: { done: true },
      }),
    );

    const result = await sendPromise;
    expect(result).toEqual({ done: true });
  });

  // 1b. Two concurrent requests correlate independently (docs/archive/33 §9): a worker
  // with parallel tool use can have a second permission.request outstanding
  // while the first is pending. Responses may arrive out of order.
  it("correlates two concurrent outstanding requests by id, even out of order", async () => {
    const { transport, stdin, stdout } = makeTransport();

    const p1 = transport.send<{ outcome: string }>("permission.request", { toolName: "bash" });
    const p2 = transport.send<{ outcome: string }>("permission.request", { toolName: "write_file" });
    await new Promise<void>((r) => setImmediate(r));

    const frames = drain(stdout)
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as IpcRequest);
    expect(frames).toHaveLength(2);
    const bash = frames.find((f) => (f.params as { toolName?: string }).toolName === "bash")!;
    const write = frames.find((f) => (f.params as { toolName?: string }).toolName === "write_file")!;
    expect(bash.id).not.toBe(write.id);

    // Respond to the SECOND request first, then the first.
    stdin.push(encodeFrame({ kind: "response", id: write.id, ok: true, result: { outcome: "deny" } }));
    stdin.push(encodeFrame({ kind: "response", id: bash.id, ok: true, result: { outcome: "allow" } }));

    expect(await p1).toEqual({ outcome: "allow" });
    expect(await p2).toEqual({ outcome: "deny" });
  });

  // 2. notify("lane_event") writes a notification frame to stdout
  it("notify writes a notification frame to stdout", async () => {
    const { transport, stdout } = makeTransport();

    await transport.notify("lane_event", { type: "tool_call", step: 1 });

    await new Promise<void>((r) => setImmediate(r));
    const written = drain(stdout);
    const frame = JSON.parse(written.trim()) as {
      kind: string;
      method: string;
      params: unknown;
    };
    expect(frame.kind).toBe("notification");
    expect(frame.method).toBe("lane_event");
    expect(frame.params).toEqual({ type: "tool_call", step: 1 });
  });

  // 3. Heartbeat: startHeartbeat fires at interval; stopHeartbeat halts it
  it("startHeartbeat emits heartbeat notifications; stopHeartbeat halts them", async () => {
    vi.useFakeTimers();

    const { transport, stdout } = makeTransport({
      heartbeatIntervalMs: 5,
      agentId: "w1",
    });

    transport.startHeartbeat();

    // Advance 12ms — should see at least 2 heartbeats (at 5ms and 10ms).
    vi.advanceTimersByTime(12);

    // Drain any pending microtask callbacks.
    await Promise.resolve();
    await Promise.resolve();

    const written = drain(stdout);
    const frames = written
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; method: string });

    const heartbeats = frames.filter((f) => f.method === "heartbeat");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    transport.stopHeartbeat();

    // Advance another 20ms — no more heartbeats after stop.
    vi.advanceTimersByTime(20);
    await Promise.resolve();

    const afterStop = drain(stdout);
    const afterFrames = afterStop
      .trim()
      .split("\n")
      .filter(Boolean);
    // No new heartbeat frames after stop.
    expect(afterFrames.every((l) => !l.includes('"heartbeat"'))).toBe(true);
  });

  // 4. Backpressure: low-priority notify is dropped when queue is full;
  //    high-priority notify (task_result) blocks instead of dropping.
  it("drops low-priority notify when outbound queue is full, blocks high-priority", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // Slow writable: never drains automatically (highWaterMark=0, write always returns false).
    const held: { cb: (() => void) | null } = { cb: null };
    const slowStdout = new Writable({
      highWaterMark: 0,
      write(_chunk, _enc, cb) {
        // Hold the callback — never call it to prevent drain accounting.
        held.cb = cb;
      },
    });

    const { transport } = makeTransport({ stdout: slowStdout });

    // Fill the outbound buffer by writing slightly-under-1MiB worth of data
    // directly to the internal counter via low-priority frames.
    // We manufacture a payload just over 1 MiB so the queue limit is hit.
    const bigPayload = "x".repeat(1024 * 1024); // exactly 1 MiB

    // This write will be accepted (buffer was 0, now ~1MiB).
    // Call the first write callback to register it in the slow writer.
    transport.notify("lane_event", { data: bigPayload });
    // Flush so the slowStdout.write() is called and the internal counter increments.
    await new Promise<void>((r) => setImmediate(r));

    // Now the outbound counter is at >= 1 MiB. Next low-priority notify should drop.
    transport.notify("lane_event", { data: "small" });
    await new Promise<void>((r) => setImmediate(r));

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("outbound queue full"),
    );

    // High-priority notify should block (not drop). We don't await it —
    // just verify it doesn't call the stderr drop warning.
    stderrSpy.mockClear();
    // Start a high-priority write — it will block waiting for drain.
    const highPriorityPromise = transport.notify("task_result", {
      agentId: "w1",
    });

    await new Promise<void>((r) => setImmediate(r));
    // It should NOT have dropped.
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("outbound queue full"),
    );

    // Unblock by calling the write callback (simulate drain).
    if (held.cb) held.cb();
    slowStdout.emit("drain");

    // Now the high-priority write should complete.
    await highPriorityPromise;

    stderrSpy.mockRestore();
  });

  // 5. Transport close: stdin "end" → pending send() rejects; "close" event emitted
  it("rejects pending send() with transport_closed when stdin ends", async () => {
    const { transport, stdin } = makeTransport();

    const p = transport.send("task.list", {});

    const closedPromise = new Promise<void>((resolve) => {
      transport.on("close", resolve);
    });

    // Simulate orchestrator closing stdin.
    stdin.push(null);

    await expect(p).rejects.toMatchObject({
      code: IPC_ERROR_CODES.TRANSPORT_CLOSED,
    });
    await closedPromise; // "close" event must have been emitted
  });

  // 6. run request from parent: stdin receives "run" frame → "run" event emitted
  //    → respond() writes response back to stdout
  it("emits run event and respond() writes response to stdout", async () => {
    const { transport, stdin, stdout } = makeTransport();

    const runSeen = new Promise<IpcRequest>((resolve) => {
      transport.on("run", (frame: IpcRequest) => resolve(frame));
    });

    // Orchestrator sends a "run" request.
    stdin.push(
      encodeFrame({
        kind: "request",
        id: "run-42",
        method: "run",
        params: { taskId: "t99" },
      }),
    );

    const frame = await runSeen;
    expect(frame.id).toBe("run-42");
    expect(frame.method).toBe("run");

    // Worker responds.
    transport.respond(frame.id, { accepted: true });

    await new Promise<void>((r) => setImmediate(r));
    const written = drain(stdout);
    const responseFrame = JSON.parse(written.trim()) as {
      kind: string;
      id: string;
      ok: boolean;
      result: unknown;
    };
    expect(responseFrame.kind).toBe("response");
    expect(responseFrame.id).toBe("run-42");
    expect(responseFrame.ok).toBe(true);
    expect(responseFrame.result).toEqual({ accepted: true });
  });

  // 7. shutdown request → "shutdown" event emitted
  it("emits shutdown event for shutdown request frames", async () => {
    const { transport, stdin } = makeTransport();

    const shutdownSeen = new Promise<IpcRequest>((resolve) => {
      transport.on("shutdown", (frame: IpcRequest) => resolve(frame));
    });

    stdin.push(
      encodeFrame({
        kind: "request",
        id: "sd-1",
        method: "shutdown",
        params: {},
      }),
    );

    const frame = await shutdownSeen;
    expect(frame.method).toBe("shutdown");
  });

  // 8. Malformed frame from parent → stderr warning, transport continues
  it("logs malformed frames to stderr and continues", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const { transport, stdin } = makeTransport();

    stdin.push("not json at all\n");
    await new Promise<void>((r) => setImmediate(r));

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("malformed frame"),
    );
    stderrSpy.mockRestore();
  });
});
