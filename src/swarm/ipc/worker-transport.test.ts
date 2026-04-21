import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { WorkerTransport } from "./worker-transport.js";
import { encodeFrame } from "./framing.js";
import { IPC_ERROR_CODES, type IpcRequest } from "./protocol.js";

// ---------------------------------------------------------------------------
// Fake child process helper
// ---------------------------------------------------------------------------

/**
 * Creates a fake ChildProcess-like object backed by PassThrough streams.
 * - `childStdout`: what the child writes (orchestrator reads from child.stdout)
 * - `childStdin`:  what the orchestrator writes (child reads from child.stdin)
 */
function makeFakeChild() {
  // The orchestrator reads from child.stdout — so "childStdout" is a
  // PassThrough that we push bytes into from the test side.
  const childStdout = new PassThrough();
  // The orchestrator writes to child.stdin — so "childStdin" is a
  // PassThrough that we read bytes from on the test side.
  const childStdin = new PassThrough();

  const emitter = new EventEmitter();

  const child = Object.assign(emitter, {
    stdout: childStdout,
    stdin: childStdin,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  }) as unknown as ChildProcess;

  return { child, childStdout, childStdin };
}

/** Read all bytes currently in a PassThrough as a UTF-8 string. */
function drainStream(stream: PassThrough): string {
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

describe("WorkerTransport", () => {
  let child: ChildProcess;
  let childStdout: PassThrough;
  let childStdin: PassThrough;
  let transport: WorkerTransport;

  beforeEach(() => {
    ({ child, childStdout, childStdin } = makeFakeChild());
    transport = new WorkerTransport(child, { defaultTimeoutMs: 60_000 });
  });

  afterEach(() => {
    // Clean up any pending timers by forcing close.
    child.emit("close", 0, null);
  });

  // 1. Round-trip: orchestrator send → fake child responds → promise resolves
  it("resolves send() when child writes a matching response", async () => {
    const sendPromise = transport.send<{ value: number }>(
      "task.get",
      { id: "t1" },
    );

    // Read the request the orchestrator wrote to child.stdin.
    await new Promise<void>((r) => setImmediate(r));
    const written = drainStream(childStdin);
    const requestFrame = JSON.parse(written.trim()) as IpcRequest;
    expect(requestFrame.kind).toBe("request");
    expect(requestFrame.method).toBe("task.get");

    // Child writes back a matching response.
    const responseFrame = encodeFrame({
      kind: "response",
      id: requestFrame.id,
      ok: true,
      result: { value: 42 },
    });
    childStdout.push(responseFrame);

    const result = await sendPromise;
    expect(result).toEqual({ value: 42 });
  });

  // 2. Notification from child → transport emits event with params
  it("emits lane_event when child writes a lane_event notification", async () => {
    const received = await new Promise<unknown>((resolve) => {
      transport.on("lane_event", resolve);
      childStdout.push(
        encodeFrame({
          kind: "notification",
          method: "lane_event",
          params: { type: "tool_call", data: "foo" },
        }),
      );
    });
    expect(received).toEqual({ type: "tool_call", data: "foo" });
  });

  // 3. Worker-initiated request → "request" event → orchestrator responds → response on child stdin
  it("emits request event for worker-initiated request and respond() writes to stdin", async () => {
    const requestSeen = new Promise<IpcRequest>((resolve) => {
      transport.on("request", (frame: IpcRequest) => resolve(frame));
    });

    const spawnFrame = encodeFrame({
      kind: "request",
      id: "spawn-1",
      method: "spawn",
      params: { role: "helper" },
    });
    childStdout.push(spawnFrame);

    const frame = await requestSeen;
    expect(frame.method).toBe("spawn");
    expect(frame.id).toBe("spawn-1");

    // Orchestrator calls respond() — should write a response to child.stdin.
    transport.respond(frame.id, { agentId: "a2" });

    await new Promise<void>((r) => setImmediate(r));
    const written = drainStream(childStdin);
    const responseFrame = JSON.parse(written.trim()) as {
      kind: string;
      id: string;
      ok: boolean;
      result: unknown;
    };
    expect(responseFrame.kind).toBe("response");
    expect(responseFrame.id).toBe("spawn-1");
    expect(responseFrame.ok).toBe(true);
    expect(responseFrame.result).toEqual({ agentId: "a2" });
  });

  // 4. Timeout: send with short timeoutMs → rejects with REQUEST_TIMEOUT
  it("rejects with request_timeout when no response arrives within timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const p = transport.send("task.get", { id: "t2" }, { timeoutMs: 50 });
      vi.advanceTimersByTime(51);
      await expect(p).rejects.toMatchObject({
        code: IPC_ERROR_CODES.REQUEST_TIMEOUT,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // 5. Transport close: child emits close → pending send rejects with TRANSPORT_CLOSED
  it("rejects pending send() with transport_closed when child closes", async () => {
    // Send without responding — leave it pending.
    const p = transport.send("task.get", { id: "t3" });

    // Simulate child exiting.
    child.emit("close", 1, null);

    await expect(p).rejects.toMatchObject({
      code: IPC_ERROR_CODES.TRANSPORT_CLOSED,
    });
  });

  // 6. Malformed frame: child writes non-JSON → transport logs to stderr, does not crash
  it("logs malformed frames to stderr and does not crash", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    childStdout.push("not json\n");

    // Allow microtasks to flush.
    await new Promise<void>((r) => setImmediate(r));

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("malformed frame"),
    );
    stderrSpy.mockRestore();

    // Transport is still usable after a malformed frame.
    expect(transport.listenerCount("error")).toBeGreaterThanOrEqual(0);
  });

  // 7. Error response from child → send() rejects with the error code
  it("rejects send() with the error code from an IpcErr response", async () => {
    const sendPromise = transport.send("task.get", { id: "t4" });

    await new Promise<void>((r) => setImmediate(r));
    const written = drainStream(childStdin);
    const requestFrame = JSON.parse(written.trim()) as IpcRequest;

    childStdout.push(
      encodeFrame({
        kind: "response",
        id: requestFrame.id,
        ok: false,
        error: { code: IPC_ERROR_CODES.INTERNAL_ERROR, message: "boom" },
      }),
    );

    await expect(sendPromise).rejects.toMatchObject({
      code: IPC_ERROR_CODES.INTERNAL_ERROR,
      message: "boom",
    });
  });
});
