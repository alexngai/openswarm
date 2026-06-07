/**
 * Live test of OpenAICodexAuth → CodexResponsesTransportProvider → backend.
 *
 * Gated behind CODEX_LIVE=1. Seeds a temp token store from the existing
 * `codex login` credentials (~/.codex/auth.json), then exercises the real
 * OpenAICodexAuth credential source (the same class the `codex-native` CLI
 * path uses) end-to-end against the live backend.
 *
 *   CODEX_LIVE=1 SWARM_HARNESS_SKIP_INTEGRATION_BUILD=1 \
 *     npx vitest run src/auth/openai-codex-oauth.live.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpenAICodexAuth } from "./openai-codex-oauth.js";
import { writeCodexTokens } from "./openai-codex-token-store.js";
import { resolveCodexExpiry } from "./openai-codex-jwt.js";
import { CodexResponsesTransportProvider } from "../providers/codex-responses/index.js";
import type { ProviderEvent, ProviderRequest } from "../providers/index.js";

const live = process.env.CODEX_LIVE === "1";
let dir: string;

beforeAll(() => {
  if (!live) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-oauth-live-"));
  const raw = fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8");
  const auth = JSON.parse(raw) as {
    tokens: { access_token: string; refresh_token: string; account_id: string };
  };
  writeCodexTokens(
    {
      access: auth.tokens.access_token,
      refresh: auth.tokens.refresh_token,
      accountId: auth.tokens.account_id,
      expiresAt: resolveCodexExpiry(auth.tokens.access_token) ?? Date.now() + 3_600_000,
    },
    dir,
  );
});
afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe.runIf(live)("OpenAICodexAuth (live, full stack)", () => {
  it("authenticates via the store and completes a turn through the provider", async () => {
    const auth = new OpenAICodexAuth({ baseDir: dir });
    expect(await auth.isAuthenticated()).toBe(true);

    const provider = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5",
      credentials: auth, // OpenAICodexAuth IS a CodexCredentialSource
      sessionId: "swarm-harness-oauth-live",
    });

    const req: ProviderRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ack" }] }],
      model: "gpt-5.5",
      sessionId: "swarm-harness-oauth-live",
    };
    const out: ProviderEvent[] = [];
    for await (const e of provider.stream(req)) out.push(e);

    const text = out.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("");
    expect(out.some((e) => e.type === "error")).toBe(false);
    expect(text.toLowerCase()).toContain("ack");
    expect(out.at(-1)).toMatchObject({ type: "finish" });
  }, 60_000);
});
