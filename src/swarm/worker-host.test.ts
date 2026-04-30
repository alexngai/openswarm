/**
 * Tests for WorkerHost — M3b Phase 6 (askUser IPC proxy).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { WorkerHost } from "./worker-host.js";
import type { ParentTransport } from "./ipc/parent-transport.js";
import type { AgentId, PermissionMode } from "../core/types.js";

/**
 * Minimal ParentTransport double: an EventEmitter with a stubbed `send`.
 * `send` is a vi.fn so tests can override per-case.
 */
function makeFakeTransport(): {
  transport: ParentTransport;
  send: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const send = vi.fn();
  const transport = Object.assign(emitter, {
    send,
    notify: vi.fn(async () => {}),
    respond: vi.fn(),
    respondError: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    close: vi.fn(),
  }) as unknown as ParentTransport;
  return { transport, send };
}

function makeHost(transport: ParentTransport): WorkerHost {
  return new WorkerHost(
    "agent-1" as AgentId,
    1,
    "workspace-write" as PermissionMode,
    transport,
  );
}

describe("WorkerHost.askUser", () => {
  const ORIGINAL_ENV = process.env.SWARM_HARNESS_ASK_TIMEOUT_MS;
  beforeEach(() => {
    delete process.env.SWARM_HARNESS_ASK_TIMEOUT_MS;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SWARM_HARNESS_ASK_TIMEOUT_MS;
    } else {
      process.env.SWARM_HARNESS_ASK_TIMEOUT_MS = ORIGINAL_ENV;
    }
  });

  it("round-trip: send resolves with {answer} → returns {status: 'answered', answer}", async () => {
    const { transport, send } = makeFakeTransport();
    send.mockResolvedValue({ answer: "yes" });
    const host = makeHost(transport);

    const result = await host.askUser("proceed?", ["yes", "no"]);
    expect(result).toEqual({ status: "answered", answer: "yes" });

    // Verify the IPC method and params.
    expect(send).toHaveBeenCalledTimes(1);
    const [method, params, opts] = send.mock.calls[0]!;
    expect(method).toBe("ask_user_question");
    expect(params).toMatchObject({
      question: "proceed?",
      options: ["yes", "no"],
      timeoutMs: 600_000,
    });
    expect(opts).toMatchObject({ timeoutMs: 600_000 });
  });

  it("timeout: send rejects with code 'request_timeout' → {status: 'timed-out'}", async () => {
    const { transport, send } = makeFakeTransport();
    send.mockRejectedValue(
      Object.assign(new Error("request ask_user_question timed out"), {
        code: "request_timeout",
      }),
    );
    const host = makeHost(transport);

    const result = await host.askUser("still there?");
    expect(result).toEqual({ status: "timed-out" });
  });

  it("transport closed: send rejects with code 'transport_closed' → {status: 'error', message}", async () => {
    const { transport, send } = makeFakeTransport();
    send.mockRejectedValue(
      Object.assign(new Error("parent closed stdin"), {
        code: "transport_closed",
      }),
    );
    const host = makeHost(transport);

    const result = await host.askUser("q");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/transport_closed/);
    }
  });

  it("honors SWARM_HARNESS_ASK_TIMEOUT_MS env override", async () => {
    process.env.SWARM_HARNESS_ASK_TIMEOUT_MS = "1500";
    const { transport, send } = makeFakeTransport();
    send.mockResolvedValue({ answer: "ok" });
    const host = makeHost(transport);

    await host.askUser("quick?");
    const [, params, opts] = send.mock.calls[0]!;
    expect(params).toMatchObject({ timeoutMs: 1500 });
    expect(opts).toMatchObject({ timeoutMs: 1500 });
  });

  it("unknown error: generic rejection → {status: 'error', message}", async () => {
    const { transport, send } = makeFakeTransport();
    send.mockRejectedValue(new Error("something else"));
    const host = makeHost(transport);

    const result = await host.askUser("x");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/something else/);
    }
  });
});
