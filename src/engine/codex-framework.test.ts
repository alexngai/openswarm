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
import type { CodexAppServerProvider } from "../providers/codex-app-server.js";

// ---------------------------------------------------------------------------
// Minimal RunConfig helper
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    systemPrompt: "",
    prompt: "hello",
    model: "gpt-5.4",
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
    startThread: vi.fn().mockResolvedValue({ threadId: "thread-abc", model: "gpt-5.4" }),
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
});
