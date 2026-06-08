/**
 * Live end-to-end smoke for CodexResponsesTransportProvider.
 *
 * Gated behind CODEX_LIVE=1 (skipped in CI). Uses the token written by
 * `codex login` (~/.codex/auth.json) as a stand-in credential source until the
 * OAuth flow lands — this validates the real request→SSE→event pipeline against
 * the live backend with code we control.
 *
 *   CODEX_LIVE=1 SWARM_HARNESS_SKIP_INTEGRATION_BUILD=1 \
 *     npx vitest run src/providers/codex-responses/index.live.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexResponsesTransportProvider, type CodexCredentialSource } from "./index.js";
import type { ProviderEvent, ProviderRequest } from "../index.js";
import type { ToolSpec } from "../../core/types.js";

const live = process.env.CODEX_LIVE === "1";

function codexLoginCredentials(): CodexCredentialSource {
  return {
    getCredentials: async () => {
      const raw = fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8");
      const auth = JSON.parse(raw) as { tokens: { access_token: string; account_id: string } };
      return { token: auth.tokens.access_token, accountId: auth.tokens.account_id };
    },
  };
}

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe.runIf(live)("CodexResponsesTransportProvider (live)", () => {
  const provider = new CodexResponsesTransportProvider({
    modelId: "gpt-5.5",
    credentials: codexLoginCredentials(),
    sessionId: "swarm-harness-live-smoke",
  });

  it("streams a plain text turn and finishes", async () => {
    const req: ProviderRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: pong" }] }],
      model: "gpt-5.5",
      sessionId: "swarm-harness-live-smoke",
    };
    const out = await collect(provider.stream(req));
    const text = out.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    const finish = out.at(-1);
    expect(out.some((e) => e.type === "error")).toBe(false);
    expect(text.toLowerCase()).toContain("pong");
    expect(finish).toMatchObject({ type: "finish", stopReason: "end_turn" });
  }, 60_000);

  it("streams a tool call", async () => {
    const tool: ToolSpec = {
      name: "get_weather",
      description: "Get the current weather for a city.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      requiredPermission: "none",
      tier: 1,
    };
    const req: ProviderRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: "Use get_weather to check Paris." }] },
      ],
      tools: [tool],
      model: "gpt-5.5",
      sessionId: "swarm-harness-live-smoke",
    };
    const out = await collect(provider.stream(req));
    const call = out.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ type: "tool-call", name: "get_weather" });
    expect(out.at(-1)).toMatchObject({ type: "finish", stopReason: "tool_use" });
  }, 60_000);

  it("completes a multi-turn tool loop (replayed function_call is accepted)", async () => {
    // This is the C5 de-risk: turn 2 replays the assistant function_call (with a
    // synthesized fc_* id) + its function_call_output. The single-turn smoke
    // never exercised this path.
    const tool: ToolSpec = {
      name: "get_weather",
      description: "Get the current weather for a city.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      requiredPermission: "none",
      tier: 1,
    };
    const session = "swarm-harness-live-multiturn";
    const userTurn = { role: "user" as const, content: [{ type: "text" as const, text: "Use get_weather to check Paris, then tell me the temperature." }] };

    const out1 = await collect(provider.stream({ messages: [userTurn], tools: [tool], model: "gpt-5.5", sessionId: session }));
    const call = out1.find((e) => e.type === "tool-call") as { id: string; name: string; input: unknown } | undefined;
    expect(call).toBeDefined();

    const req2: ProviderRequest = {
      messages: [
        userTurn,
        { role: "assistant", content: [{ type: "tool_use", id: call!.id, name: call!.name, input: call!.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call!.id, content: JSON.stringify({ tempC: 18, sky: "clear" }) }] },
      ],
      tools: [tool],
      model: "gpt-5.5",
      sessionId: session,
    };
    const out2 = await collect(provider.stream(req2));
    expect(out2.some((e) => e.type === "error")).toBe(false); // would be a 400 if fc id were rejected
    const text2 = out2.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(text2.length).toBeGreaterThan(0);
    expect(out2.at(-1)).toMatchObject({ type: "finish" });
  }, 90_000);

  it("replays reasoning across turns without rejection (#6.1)", async () => {
    // effort:high reliably produces a reasoning item (with encrypted_content);
    // turn 2 replays it as a reasoning input item — a 400 here would mean the
    // synthesized/normalized reasoning replay was rejected.
    const reasoningProvider = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5",
      credentials: codexLoginCredentials(),
      sessionId: "swarm-harness-live-reasoning",
      reasoning: { effort: "high", summary: "auto" },
    });
    const userTurn = { role: "user" as const, content: [{ type: "text" as const, text: "Reason step by step about whether 17 is prime, then state the answer." }] };

    const out1 = await collect(reasoningProvider.stream({ messages: [userTurn], model: "gpt-5.5", sessionId: "swarm-harness-live-reasoning" }));
    const reasoning = out1.find((e) => e.type === "reasoning") as { signature: string } | undefined;
    const text1 = out1.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(reasoning, "expected a reasoning item at effort:high").toBeDefined();

    const req2: ProviderRequest = {
      messages: [
        userTurn,
        {
          role: "assistant",
          content: [
            { type: "reasoning", signature: reasoning!.signature },
            { type: "text", text: text1 || "17 is prime." },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Reply with exactly: confirmed" }] },
      ],
      model: "gpt-5.5",
      sessionId: "swarm-harness-live-reasoning",
    };
    const out2 = await collect(reasoningProvider.stream(req2));
    expect(out2.some((e) => e.type === "error")).toBe(false); // 400 if reasoning replay rejected
    expect(out2.at(-1)).toMatchObject({ type: "finish" });
  }, 120_000);
});
