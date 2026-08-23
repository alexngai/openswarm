/**
 * prefix-stability.test.ts — native-path request-prefix byte-stability guard
 * (docs/55 TE-23).
 *
 * The AI-SDK transports assemble every request themselves (system join,
 * message replay, tool translation, provider options). Prefix-caching
 * providers (DeepSeek, OpenAI, Azure via prompt_cache_key, …) serve the
 * longest BYTE-IDENTICAL prefix from cache — so any nondeterminism in our
 * assembly (timestamps, map iteration order, per-call schema conversion,
 * rewritten history) silently cold-starts the cache on every non-Anthropic
 * provider. This guard pins the property at the streamText() boundary — the
 * full serialized output of the assembly code we own. (The AI SDK's own
 * HTTP-body construction from identical arguments is the SDK's contract, and
 * real tool schemas are converted from Zod once at module load — see
 * z.toJSONSchema call sites in src/tools/tier0/*.)
 *
 * Modeled on DeepSeek-Reasonix's boot-level byte-stability guard
 * (TestBuildComposesByteStableSystemPrompt): compare serialized snapshots,
 * fail loudly naming the drifting component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: vi.fn() };
});

import { OpenAITransportProvider } from "./openai-transport.js";
import { OpenAIEnvAuth } from "../auth/openai-env.js";
import type { ProviderMessage, ProviderRequest } from "./index.js";
import { streamText } from "ai";
import { readFileTool } from "../tools/tier0/read_file.js";
import { writeFileTool } from "../tools/tier0/write_file.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = "You are a coding agent. Follow the project rules.";

/** Real tier-0 specs so the guarded surface is the real tool surface. */
const TOOLS = [readFileTool.spec, writeFileTool.spec];

function userMsg(text: string): ProviderMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): ProviderMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function makeReq(messages: readonly ProviderMessage[]): ProviderRequest {
  return {
    messages,
    tools: TOOLS,
    systemPrompt: SYSTEM_PROMPT,
    model: "gpt-4o",
    sessionId: "session-fixed",
  } as ProviderRequest;
}

async function* finishOnly(): AsyncIterable<unknown> {
  yield {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: { inputTokens: 1, outputTokens: 1, inputTokenDetails: {}, outputTokenDetails: {} },
  };
}

async function drain(req: ProviderRequest): Promise<void> {
  (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
    fullStream: finishOnly(),
  });
  const provider = await OpenAITransportProvider.create(new OpenAIEnvAuth(), "gpt-4o");
  for await (const _ of provider.stream(req)) {
    void _;
  }
}

/**
 * Byte-serialized snapshot of the cacheable prefix components of one
 * streamText() call. Comparing these across turns IS the guard: a mismatch
 * names the drifting component.
 */
interface PrefixSnapshot {
  readonly system: string;
  readonly tools: string;
  readonly providerOptions: string;
  readonly messages: readonly string[];
}

function snapshotCall(callIndex: number): PrefixSnapshot {
  const calls = (streamText as ReturnType<typeof vi.fn>).mock.calls;
  const args = calls[callIndex]![0] as {
    system?: string;
    tools: unknown;
    providerOptions?: unknown;
    messages: readonly unknown[];
  };
  return {
    system: JSON.stringify(args.system ?? null),
    tools: JSON.stringify(args.tools),
    providerOptions: JSON.stringify(args.providerOptions ?? null),
    messages: args.messages.map((m) => JSON.stringify(m)),
  };
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

describe("native-path request-prefix byte-stability (TE-23)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("tool serialization is non-vacuous (real schema bytes reach the comparison)", async () => {
    await drain(makeReq([userMsg("read a file")]));
    const snap = snapshotCall(0);
    // If the jsonSchema() wrapper ever hides the schema from JSON.stringify,
    // every byte-comparison below becomes vacuously true — fail here instead.
    expect(snap.tools).toContain("read_file");
    expect(snap.tools).toContain("file_path");
    expect(snap.tools.length).toBeGreaterThan(200);
  });

  it("identical requests serialize byte-identically (no per-call nondeterminism)", async () => {
    const messages = [userMsg("first question")];
    await drain(makeReq(messages));
    // Cross a millisecond boundary between the calls: a Date.now()-derived
    // value in the assembly serializes identically when both calls land in
    // the same ms, which would let timestamp drift slip past this guard
    // (verified against an injected `[ts:${Date.now()}]` — 0ms apart passed,
    // delayed failed).
    await new Promise((r) => setTimeout(r, 10));
    await drain(makeReq(messages));
    const a = snapshotCall(0);
    const b = snapshotCall(1);
    expect(b.system).toBe(a.system);
    expect(b.tools).toBe(a.tools);
    expect(b.providerOptions).toBe(a.providerOptions);
    expect(b.messages).toEqual(a.messages);
  });

  it("appending a turn preserves the serialized prefix byte-for-byte", async () => {
    const turn1 = [userMsg("first question")];
    const turn2 = [
      ...turn1,
      assistantMsg("first answer"),
      userMsg("follow-up question"),
    ];
    await drain(makeReq(turn1));
    await drain(makeReq(turn2));
    const a = snapshotCall(0);
    const b = snapshotCall(1);
    // The cache-critical components must not move between turns.
    expect(b.system).toBe(a.system);
    expect(b.tools).toBe(a.tools);
    expect(b.providerOptions).toBe(a.providerOptions);
    // History must grow append-only: turn 2's serialized messages start with
    // turn 1's, byte-for-byte.
    expect(b.messages.length).toBeGreaterThan(a.messages.length);
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
  });

  it("prefix survives a tool_result round-trip (the common agentic shape)", async () => {
    const turn1: ProviderMessage[] = [userMsg("read src/cli.ts")];
    const turn2: ProviderMessage[] = [
      ...turn1,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it now." },
          { type: "tool_use", id: "tu-1", name: "read_file", input: { file_path: "src/cli.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "// cli contents" }],
      },
    ];
    await drain(makeReq(turn1));
    await drain(makeReq(turn2));
    const a = snapshotCall(0);
    const b = snapshotCall(1);
    expect(b.system).toBe(a.system);
    expect(b.tools).toBe(a.tools);
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
  });
});
