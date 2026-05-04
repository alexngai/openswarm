/**
 * Tests for WorkerHost — M3b Phase 6 (askUser IPC proxy) + Phase 5 Stage B (lifecycle state machine)
 * + v0.2 Stage 2B (state file writes on lifecycle transitions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { WorkerHost } from "./worker-host.js";
import { readWorkerState } from "./worker-state-file.js";
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

describe("WorkerHost.scopeOf (v0.4 stage 4M.7)", () => {
  it("returns env-derived teamScope for own agentId", () => {
    const { transport } = makeFakeTransport();
    const host = new WorkerHost(
      "agent-1" as AgentId,
      1,
      "workspace-write" as PermissionMode,
      transport,
      undefined,
      undefined,
      "swarm:gsd",
    );
    expect(host.scopeOf("agent-1" as AgentId)).toBe("swarm:gsd");
  });

  it('defaults to "swarm:default" when no teamScope is provided', () => {
    const { transport } = makeFakeTransport();
    const host = new WorkerHost(
      "agent-1" as AgentId,
      1,
      "workspace-write" as PermissionMode,
      transport,
    );
    expect(host.scopeOf("agent-1" as AgentId)).toBe("swarm:default");
  });

  it("throws when asked about another agent's scope (worker only knows self)", () => {
    const { transport } = makeFakeTransport();
    const host = new WorkerHost(
      "agent-1" as AgentId,
      1,
      "workspace-write" as PermissionMode,
      transport,
      undefined,
      undefined,
      "swarm:gsd",
    );
    expect(() => host.scopeOf("agent-2" as AgentId)).toThrow(/non-self/);
  });
});

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

describe("WorkerHost lifecycle state machine", () => {
  it("initial state is 'spawning'", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);
    expect(host.getLifecycleState()).toBe("spawning");
  });

  it("valid transition updates state and emits lane event", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    // Access private method via cast for testing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (host as any)._transitionTo("ready_for_prompt");

    expect(host.getLifecycleState()).toBe("ready_for_prompt");

    // Verify the lane event was emitted via transport.notify.
    expect(transport.notify).toHaveBeenCalledTimes(1);
    const [method, params] = (transport.notify as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(method).toBe("lane_event");
    const payload = (params as { payload: unknown }).payload as {
      from: string;
      to: string;
    };
    expect(payload.from).toBe("spawning");
    expect(payload.to).toBe("ready_for_prompt");
  });

  it("invalid transition (ready_for_prompt → running) does not change state and logs a warning", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    // First do a valid transition to ready_for_prompt.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (host as any)._transitionTo("ready_for_prompt");
    const notifyCallsBefore = (transport.notify as ReturnType<typeof vi.fn>).mock.calls.length;

    // Now attempt the invalid transition.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (host as any)._transitionTo("running");
    stderrSpy.mockRestore();

    // State must not have changed.
    expect(host.getLifecycleState()).toBe("ready_for_prompt");
    // No additional lane event emitted.
    expect((transport.notify as ReturnType<typeof vi.fn>).mock.calls.length).toBe(notifyCallsBefore);
  });
});

// ---------------------------------------------------------------------------
// State-file writes (v0.2 Stage 2B)
// SWARM_HARNESS_WORKERS_DIR is set to a tmp dir by vitest-setup.ts, so these
// writes never touch ~/.swarm-harness/workers/.
// ---------------------------------------------------------------------------

describe("WorkerHost state file writes", () => {
  it("writes state file on construction with lifecycleState=spawning", () => {
    const { transport } = makeFakeTransport();
    const agentId = "state-file-agent-1" as AgentId;
    new WorkerHost(agentId, 1, "workspace-write" as PermissionMode, transport);

    const state = readWorkerState(agentId);
    expect(state).not.toBeNull();
    expect(state!.agentId).toBe(agentId);
    expect(state!.lifecycleState).toBe("spawning");
    expect(state!.pid).toBe(process.pid);
  });

  it("writes terminal state (finished) with taskId after running", () => {
    // Intermediate transitions (ready_for_prompt, running) do not write the
    // state file — only construction (spawning) and terminal states do.
    // This avoids ~4x slowdown from per-transition fsync in concurrent tests.
    const { transport } = makeFakeTransport();
    const agentId = "state-file-agent-2" as AgentId;
    const host = new WorkerHost(agentId, 1, "workspace-write" as PermissionMode, transport);

    // Intermediate transitions must not change the on-disk state.
    host.markReadyForPrompt();
    expect(readWorkerState(agentId)!.lifecycleState).toBe("spawning");

    host.markRunning("task-xyz");
    expect(readWorkerState(agentId)!.lifecycleState).toBe("spawning");

    // Terminal transition writes with the accumulated taskId.
    host.markFinished();
    const finished = readWorkerState(agentId)!;
    expect(finished.lifecycleState).toBe("finished");
    expect(finished.taskId).toBe("task-xyz");
  });

  it("markFailed persists failureClass and reason", () => {
    const { transport } = makeFakeTransport();
    const agentId = "state-file-agent-3" as AgentId;
    const host = new WorkerHost(agentId, 1, "workspace-write" as PermissionMode, transport);
    host.markReadyForPrompt();
    host.markRunning();
    host.markFailed("panic", "engine blew up");

    const state = readWorkerState(agentId)!;
    expect(state.lifecycleState).toBe("failed");
    expect(state.failureClass).toBe("panic");
    expect(state.reason).toBe("engine blew up");
  });

  it("persists parentAgentId when provided at construction", () => {
    const { transport } = makeFakeTransport();
    const agentId = "state-file-agent-4" as AgentId;
    const parentAgentId = "parent-agent" as AgentId;
    new WorkerHost(agentId, 2, "workspace-write" as PermissionMode, transport, undefined, parentAgentId);

    const state = readWorkerState(agentId)!;
    expect(state.parentAgentId).toBe(parentAgentId);
  });
});

describe("WorkerHost public lifecycle wrappers", () => {
  function getLaneEvents(transport: ParentTransport): Array<{ from: string; to: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (transport.notify as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: any[]) => call[0] === "lane_event")
      .map((call: any[]) => ({
        from: (call[1] as { payload: { from: string; to: string } }).payload.from,
        to: (call[1] as { payload: { from: string; to: string } }).payload.to,
      }));
  }

  it("markReadyForPrompt: state becomes ready_for_prompt and a lane event fires", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    host.markReadyForPrompt();

    expect(host.getLifecycleState()).toBe("ready_for_prompt");
    const events = getLaneEvents(transport);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ from: "spawning", to: "ready_for_prompt" });
  });

  it("markRunning: fires prompt_accepted then running as separate lane events", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    host.markReadyForPrompt();
    host.markRunning();

    expect(host.getLifecycleState()).toBe("running");
    const events = getLaneEvents(transport);
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual({ from: "ready_for_prompt", to: "prompt_accepted" });
    expect(events[2]).toEqual({ from: "prompt_accepted", to: "running" });
  });

  it("markFinished: state becomes finished after running", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    host.markReadyForPrompt();
    host.markRunning();
    host.markFinished();

    expect(host.getLifecycleState()).toBe("finished");
    const events = getLaneEvents(transport);
    expect(events[events.length - 1]).toEqual({ from: "running", to: "finished" });
  });

  // v0.4 stage 4M.3 (M5): long-lived workers transition running → idle
  // after each turn, then idle → prompt_accepted → running on the next
  // run_more, then idle → drained on graceful drain.
  it("markIdle: state becomes idle after running (long-lived path)", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    host.markReadyForPrompt();
    host.markRunning();
    host.markIdle();

    expect(host.getLifecycleState()).toBe("idle");
    const events = getLaneEvents(transport);
    expect(events[events.length - 1]).toEqual({ from: "running", to: "idle" });
  });

  it("idle → prompt_accepted → running cycle: subsequent run_more re-enters running", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    host.markReadyForPrompt();
    host.markRunning();        // turn 1
    host.markIdle();           // turn 1 done
    host.markRunning();        // turn 2 — idle → prompt_accepted → running
    expect(host.getLifecycleState()).toBe("running");
    host.markIdle();           // turn 2 done
    expect(host.getLifecycleState()).toBe("idle");
  });

  it("markDrained: state becomes drained after idle (graceful long-lived exit)", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    host.markReadyForPrompt();
    host.markRunning();
    host.markIdle();
    host.markDrained();

    expect(host.getLifecycleState()).toBe("drained");
    const events = getLaneEvents(transport);
    expect(events[events.length - 1]).toEqual({ from: "idle", to: "drained" });
  });

  it("markFailed: state becomes failed, lane event carries failureClass and reason", () => {
    const { transport } = makeFakeTransport();
    const host = makeHost(transport);

    host.markReadyForPrompt();
    host.markRunning();
    host.markFailed("panic", "engine threw");

    expect(host.getLifecycleState()).toBe("failed");
    const notifyCalls = (transport.notify as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = notifyCalls[notifyCalls.length - 1]!;
    expect(lastCall[0]).toBe("lane_event");
    const payload = (lastCall[1] as { payload: Record<string, unknown> }).payload;
    expect(payload.from).toBe("running");
    expect(payload.to).toBe("failed");
    expect(payload.failureClass).toBe("panic");
    expect(payload.reason).toBe("engine threw");
  });
});
