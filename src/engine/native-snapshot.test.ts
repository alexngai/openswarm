import { describe, it, expect } from "vitest";
import { makeSnapshot, extractNativeSnapshot } from "./native-snapshot.js";
import { buildCodexRequest } from "../providers/codex-responses/request-builder.js";
import type { ProviderMessage } from "../providers/index.js";

describe("native snapshot — reasoning round-trip (resume)", () => {
  it("preserves an assistant reasoning block through serialize/deserialize, then replays it", () => {
    const sig = JSON.stringify({ id: "rs_1", type: "reasoning", encrypted_content: "ENC", summary: [] });
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "reasoning", signature: sig }, { type: "text", text: "ok" }] },
    ];
    const snap = makeSnapshot(messages, 1, 0, { inputTokens: 0, outputTokens: 0 });

    // Simulate a process restart: write to disk + read back (JSON round-trip).
    const restored = extractNativeSnapshot(JSON.parse(JSON.stringify(snap)) as typeof snap);

    const assistant = restored.messages.find((m) => m.role === "assistant")!;
    // The signature is a JSON string nested inside the message JSON — confirm it
    // survives the double-encode/decode intact (no escaping corruption).
    expect(assistant.content[0]).toEqual({ type: "reasoning", signature: sig });

    // And it still replays to a reasoning input item on the codex path.
    const body = buildCodexRequest({ messages: restored.messages, model: "gpt-5.5" });
    expect(body.input[1]).toEqual({ type: "reasoning", encrypted_content: "ENC", summary: [] });
  });
});
