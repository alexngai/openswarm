/**
 * Regression test for the SDK-mismatch fallback path where
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY is NOT exported by the installed SDK
 * (older / newer / non-Anthropic SDK versions). The engine must:
 *   1. Fall back to passing systemPrompt as a plain string.
 *   2. Yield an error NormalizedEvent with code "prompt_cache_unavailable"
 *      once, before any stream content, so callers can surface the loss
 *      of caching without racing against the first text_delta.
 *
 * Lives in its own file because the top-level vi.mock in
 * claude-agent-sdk.test.ts unconditionally exports the boundary constant.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedEvent } from "../core/types.js";

const mockQueryMessages: object[] = [];

// Mock SDK WITHOUT the SYSTEM_PROMPT_DYNAMIC_BOUNDARY export.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn((_params: unknown) => {
      async function* gen() {
        for (const m of mockQueryMessages) yield m;
      }
      const it = gen();
      return {
        [Symbol.asyncIterator]: () => it,
        next: it.next.bind(it),
        return: it.return.bind(it),
        throw: it.throw.bind(it),
      };
    }),
    createSdkMcpServer: vi.fn(() => ({
      type: "sdk" as const,
      instance: { name: "swarm-coder" },
    })),
    tool: vi.fn((name: string, description: string, _schema: unknown) => ({
      name,
      description,
      inputSchema: {},
    })),
    // Explicitly undefined: simulates older SDK versions that don't export
    // the prompt-cache boundary constant. Vitest requires the named export
    // to exist on the mock object; exporting `undefined` lets the engine's
    // `typeof X === "string"` check fall through to the plain-string path.
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: undefined,
  };
});

import { ClaudeAgentSdkEngine } from "./claude-agent-sdk.js";
import type { RunConfig } from "./index.js";

function makeConfig(): RunConfig {
  return {
    systemPrompt: "you are a tester",
    prompt: "hi",
    model: "claude-sonnet-4-6",
    auth: {
      kind: "api-key" as const,
      providerId: "anthropic",
      isAuthenticated: async () => true,
      headers: async () => ({}),
    },
    tools: [],
    canUseTool: async () => ({ allow: true }),
    permissionMode: "workspace-write",
  };
}

describe("prompt_cache_unavailable fallback — SDK missing BOUNDARY export", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      result: "",
      usage: { input_tokens: 1, output_tokens: 1 },
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
      session_id: "s1",
      uuid: "u1",
    });
  });

  it("yields a prompt_cache_unavailable error event once", async () => {
    const engine = new ClaudeAgentSdkEngine();
    const events: NormalizedEvent[] = [];
    for await (const e of engine.run(makeConfig())) events.push(e);
    const unavailable = events.filter(
      (e) => e.type === "error" && e.error.code === "prompt_cache_unavailable",
    );
    expect(unavailable).toHaveLength(1);
  });

  it("passes systemPrompt as a plain string (not an array) to query()", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const engine = new ClaudeAgentSdkEngine();
    for await (const _ of engine.run(makeConfig())) { /* drain */ }
    const args = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { systemPrompt?: string | readonly string[] };
    };
    expect(typeof args?.options?.systemPrompt).toBe("string");
    expect(Array.isArray(args?.options?.systemPrompt)).toBe(false);
  });

  it("emits the unavailable event BEFORE any stream content", async () => {
    const engine = new ClaudeAgentSdkEngine();
    const events: NormalizedEvent[] = [];
    for await (const e of engine.run(makeConfig())) events.push(e);
    const idx = events.findIndex(
      (e) => e.type === "error" && e.error.code === "prompt_cache_unavailable",
    );
    // First event overall — no text_delta / tool_use races ahead of it.
    expect(idx).toBe(0);
  });
});
