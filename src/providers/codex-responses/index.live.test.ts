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
});
