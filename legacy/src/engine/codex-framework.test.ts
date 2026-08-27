/**
 * Unit tests for CodexFrameworkEngine.
 *
 * CodexAppServerProvider is injected via providerFactory so no subprocess
 * is spawned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexFrameworkEngine } from "./codex-framework.js";
import type { NormalizedEvent, Usage } from "../core/types.js";
import type { RunConfig } from "./index.js";
import type {
  CodexAppServerProvider,
  DynamicToolCallHandler,
} from "../providers/codex-app-server.js";
import type { DynamicToolCallResponse } from "../providers/codex-app-server-types.js";
import type { SandboxMode } from "../providers/codex-app-server.js";
import type { ToolImpl } from "../tools/types.js";
import { ToolAccesses } from "../tools/access.js";

// ---------------------------------------------------------------------------
// Minimal RunConfig helper
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    systemPrompt: "",
    prompt: "hello",
    model: "gpt-5.5",
    auth: {} as RunConfig["auth"],
    tools: [],
    canUseTool: async () => ({ allow: true }),
    permissionMode: "workspace-write",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock provider factory helper
// ---------------------------------------------------------------------------

interface MockProvider {
  start: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  archiveThread: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getCumulativeUsage: ReturnType<typeof vi.fn>;
}

function makeMockProvider(overrides: Partial<MockProvider> = {}): MockProvider {
  return {
    start: vi.fn().mockResolvedValue({ userAgent: "codex/test" }),
    startThread: vi.fn().mockResolvedValue({ threadId: "thread-abc", model: "gpt-5.5" }),
    runTurn: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: "text_delta", text: "Hello" } as NormalizedEvent;
        yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } as NormalizedEvent;
      })(),
    ),
    archiveThread: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    getCumulativeUsage: vi.fn().mockReturnValue({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexFrameworkEngine", () => {
  describe("run() lazily starts the provider on first call", () => {
    it("calls start() and startThread() exactly once on first run()", async () => {
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      const events: NormalizedEvent[] = [];
      for await (const ev of engine.run(makeConfig())) {
        events.push(ev);
      }

      expect(mock.start).toHaveBeenCalledTimes(1);
      expect(mock.startThread).toHaveBeenCalledTimes(1);
    });

    it("does not call start() again on second run()", async () => {
      const mock = makeMockProvider();
      // runTurn needs a fresh async iterable each call
      mock.runTurn
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } as NormalizedEvent;
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } as NormalizedEvent;
          })(),
        );

      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      for await (const _ of engine.run(makeConfig())) { /* drain */ }
      for await (const _ of engine.run(makeConfig())) { /* drain */ }

      expect(mock.start).toHaveBeenCalledTimes(1);
      expect(mock.startThread).toHaveBeenCalledTimes(1);
    });
  });

  describe("WP-04: the session's permission mode governs codex's own tooling", () => {
    // Codex runs its file and shell tools in its own process, so they never
    // reach canUseTool and openswarm's containment does not apply. The sandbox
    // mode is the only lever, which makes an omitted permission mode a
    // fully-privileged agent unless the default is the restrictive end.
    function sandboxFor(opts: ConstructorParameters<typeof CodexFrameworkEngine>[0]) {
      let seen: SandboxMode | undefined;
      new CodexFrameworkEngine({
        ...opts,
        providerFactory: (args) => {
          seen = args.sandbox;
          return makeMockProvider() as unknown as CodexAppServerProvider;
        },
      });
      return seen;
    }

    it.each([
      ["read-only", "read-only"],
      ["workspace-write", "workspace-write"],
      ["danger-full-access", "danger-full-access"],
    ] as const)("maps permission mode %s onto codex sandbox %s", (mode, expected) => {
      expect(sandboxFor({ permissionMode: mode })).toBe(expected);
    });

    it("falls back to read-only when no permission mode is given", () => {
      expect(sandboxFor({})).toBe("read-only");
    });

    it("never leaves the sandbox for codex to choose", () => {
      expect(sandboxFor({})).not.toBeUndefined();
    });
  });

  describe("default model substitution (ChatGPT-account allowlist drift)", () => {
    it("substitutes gpt-5.5 when the caller's model is not Codex-compatible", async () => {
      // A non-codex model (the CLI default is a Claude id) must be replaced —
      // the backend rejects claude*, and as of docs/42 it also rejects gpt-5.4
      // and all -codex variants on ChatGPT accounts. gpt-5.5 is the working default.
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      for await (const _ of engine.run(makeConfig({ model: "claude-sonnet-4-6" }))) { /* drain */ }

      expect(mock.startThread).toHaveBeenCalledWith({ model: "gpt-5.5" });
    });

    it("passes a Codex-compatible model through unchanged", async () => {
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      for await (const _ of engine.run(makeConfig({ model: "gpt-5.5" }))) { /* drain */ }

      expect(mock.startThread).toHaveBeenCalledWith({ model: "gpt-5.5" });
    });
  });

  describe("run() yields NormalizedEvents from the provider's runTurn", () => {
    it("surfaces text_delta and message_stop events", async () => {
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      const events: NormalizedEvent[] = [];
      for await (const ev of engine.run(makeConfig())) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "text_delta", text: "Hello" });
      expect(events[1]).toMatchObject({ type: "message_stop", stopReason: "end_turn" });
    });
  });

  describe("Multiple run() calls reuse the same thread", () => {
    it("passes the same threadId to runTurn on every call", async () => {
      const mock = makeMockProvider();
      mock.runTurn
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } as NormalizedEvent;
          })(),
        )
        .mockReturnValueOnce(
          (async function* () {
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } as NormalizedEvent;
          })(),
        );

      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      for await (const _ of engine.run(makeConfig({ prompt: "turn1" }))) { /* drain */ }
      for await (const _ of engine.run(makeConfig({ prompt: "turn2" }))) { /* drain */ }

      const firstCallThreadId = (mock.runTurn.mock.calls[0] as unknown[])[0];
      const secondCallThreadId = (mock.runTurn.mock.calls[1] as unknown[])[0];
      expect(firstCallThreadId).toBe("thread-abc");
      expect(secondCallThreadId).toBe("thread-abc");
    });
  });

  describe("dispose() archives the thread and disposes the provider", () => {
    it("calls archiveThread then dispose after a run()", async () => {
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      for await (const _ of engine.run(makeConfig())) { /* drain */ }
      await engine.dispose();

      expect(mock.archiveThread).toHaveBeenCalledWith("thread-abc");
      expect(mock.dispose).toHaveBeenCalledTimes(1);
    });

    it("calls dispose even if provider was never started", async () => {
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      await engine.dispose();

      expect(mock.archiveThread).not.toHaveBeenCalled();
      expect(mock.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("dead engine: run() after error yields dead-engine error without spawning (Defect 4)", () => {
    it("yields dead-engine error on second run() after first turn errored", async () => {
      const mock = makeMockProvider({
        runTurn: vi.fn().mockReturnValue(
          (async function* () {
            yield { type: "error", error: { code: "transport", message: "connection refused", retryable: false } } as NormalizedEvent;
            yield { type: "message_stop", stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } } as NormalizedEvent;
          })(),
        ),
      });
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      const events1: NormalizedEvent[] = [];
      for await (const ev of engine.run(makeConfig({ prompt: "turn1" }))) {
        events1.push(ev);
      }
      // First run yields the error event.
      expect(events1.some((e) => e.type === "error")).toBe(true);

      // Second run — engine is dead, no new spawn or runTurn call.
      const events2: NormalizedEvent[] = [];
      for await (const ev of engine.run(makeConfig({ prompt: "turn2" }))) {
        events2.push(ev);
      }
      expect(events2).toHaveLength(1);
      expect(events2[0]!.type).toBe("error");
      const errEvent = events2[0] as { type: "error"; error: { code: string; message: string } };
      expect(errEvent.error.code).toBe("invalid_request");
      expect(errEvent.error.message).toContain("failed state");

      // runTurn was only called once (for the first turn).
      expect(mock.runTurn).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCumulativeUsage delegates to the provider", () => {
    it("returns zeros before any run()", () => {
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      const usage = engine.getCumulativeUsage();
      expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it("returns provider usage after a run()", async () => {
      const mock = makeMockProvider();
      const engine = new CodexFrameworkEngine({
        providerFactory: () => mock as unknown as CodexAppServerProvider,
      });

      for await (const _ of engine.run(makeConfig())) { /* drain */ }

      const usage = engine.getCumulativeUsage();
      expect(usage.inputTokens).toBe(10);
      expect(usage.outputTokens).toBe(5);
    });
  });

  describe("dynamic tool calls are gated by canUseTool", () => {
    /**
     * Builds an engine whose provider calls the dynamic-tool handler in the
     * middle of a turn, which is when a real Codex tool call arrives and the
     * only time the run's gate is published.
     */
    function makeGatedEngine(execute: ToolImpl["execute"]) {
      const tool: ToolImpl = {
        spec: {
          name: "probe",
          description: "test tool",
          inputSchema: { type: "object", properties: {} } as ToolImpl["spec"]["inputSchema"],
          requiredPermission: "write",
          tier: 2,
        },
        execute,
        accesses: () => ToolAccesses.none(),
      };

      let handler: DynamicToolCallHandler | undefined;
      let response: DynamicToolCallResponse | undefined;

      const mock = makeMockProvider({
        runTurn: vi.fn().mockReturnValue(
          (async function* () {
            yield { type: "text_delta", text: "calling" } as NormalizedEvent;
            response = await handler!("probe", { n: 1 }, {} as never);
            yield {
              type: "message_stop",
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            } as NormalizedEvent;
          })(),
        ),
      });

      const engine = new CodexFrameworkEngine({
        tools: [tool],
        providerFactory: (args) => {
          handler = args.onDynamicToolCall;
          return mock as unknown as CodexAppServerProvider;
        },
      });

      return {
        engine,
        getHandler: () => handler,
        getResponse: () => response,
      };
    }

    it("executes the tool when the gate allows it", async () => {
      const execute = vi.fn().mockResolvedValue({ status: "ok", output: "ran" });
      const { engine, getResponse } = makeGatedEngine(execute);

      for await (const _ of engine.run(makeConfig())) { /* drain */ }

      expect(execute).toHaveBeenCalledTimes(1);
      expect(getResponse()?.success).toBe(true);
    });

    it("does not execute the tool when the gate denies it", async () => {
      const execute = vi.fn().mockResolvedValue({ status: "ok", output: "ran" });
      const { engine, getResponse } = makeGatedEngine(execute);

      const config = makeConfig({
        canUseTool: async () => ({ allow: false, reason: "denied by policy" }),
      });
      for await (const _ of engine.run(config)) { /* drain */ }

      expect(execute).not.toHaveBeenCalled();
      const response = getResponse();
      expect(response?.success).toBe(false);
      expect(JSON.stringify(response?.contentItems)).toContain("denied by policy");
    });

    it("passes the gate's updatedInput to the tool", async () => {
      const execute = vi.fn().mockResolvedValue({ status: "ok", output: "ran" });
      const { engine } = makeGatedEngine(execute);

      const config = makeConfig({
        canUseTool: async () => ({ allow: true, updatedInput: { n: 99 } }),
      });
      for await (const _ of engine.run(config)) { /* drain */ }

      expect(execute).toHaveBeenCalledWith({ n: 99 }, expect.anything());
    });

    it("denies rather than executes when the gate itself throws", async () => {
      const execute = vi.fn().mockResolvedValue({ status: "ok", output: "ran" });
      const { engine, getResponse } = makeGatedEngine(execute);

      const config = makeConfig({
        canUseTool: async () => {
          throw new Error("bridge unavailable");
        },
      });
      for await (const _ of engine.run(config)) { /* drain */ }

      expect(execute).not.toHaveBeenCalled();
      expect(getResponse()?.success).toBe(false);
      expect(JSON.stringify(getResponse()?.contentItems)).toContain("bridge unavailable");
    });

    it("denies a call that arrives outside a run, and retires the gate afterwards", async () => {
      const execute = vi.fn().mockResolvedValue({ status: "ok", output: "ran" });
      const { engine, getHandler } = makeGatedEngine(execute);

      for await (const _ of engine.run(makeConfig())) { /* drain */ }
      execute.mockClear();

      // The turn is over; a late tool call has no gate to consult.
      const late = await getHandler()!("probe", { n: 2 }, {} as never);

      expect(execute).not.toHaveBeenCalled();
      expect(late.success).toBe(false);
      expect(JSON.stringify(late.contentItems)).toContain("outside a run");
    });
  });
});
