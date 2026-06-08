import { describe, it, expect } from "vitest";
import {
  resolveCodexWsUrl,
  buildCodexWsHeaders,
  buildWsTurnBody,
  wsBodyKey,
  isWebSocketReusable,
  OPENAI_BETA_RESPONSES_WEBSOCKETS,
  type WsContinuation,
} from "./websocket.js";
import type { CodexRequestBody, CodexInputItem } from "./types.js";

const A: CodexInputItem = { type: "message", role: "user", content: [{ type: "input_text", text: "A" }] };
const B: CodexInputItem = { type: "message", role: "assistant", content: [{ type: "output_text", text: "B", annotations: [] }] };
const C: CodexInputItem = { type: "function_call_output", call_id: "c1", output: "ok" };
const X: CodexInputItem = { type: "message", role: "user", content: [{ type: "input_text", text: "X" }] };

function mkBody(input: CodexInputItem[], over: Partial<CodexRequestBody> = {}): CodexRequestBody {
  return {
    model: "gpt-5.5",
    instructions: "sys",
    input,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...over,
  };
}

describe("resolveCodexWsUrl", () => {
  it("rewrites https→wss", () => {
    expect(resolveCodexWsUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(
      "wss://chatgpt.com/backend-api/codex/responses",
    );
  });
});

describe("buildCodexWsHeaders", () => {
  it("uses the WS beta and drops SSE-only headers", () => {
    const h = buildCodexWsHeaders({ token: "t", accountId: "a", sessionId: "s" });
    expect(h["OpenAI-Beta"]).toBe(OPENAI_BETA_RESPONSES_WEBSOCKETS);
    expect(h["accept"]).toBeUndefined();
    expect(h["content-type"]).toBeUndefined();
    expect(h["Authorization"]).toBe("Bearer t");
    expect(h["chatgpt-account-id"]).toBe("a");
  });
});

describe("isWebSocketReusable", () => {
  it("true for null-readyState or OPEN, false otherwise", () => {
    expect(isWebSocketReusable(null)).toBe(false);
    expect(isWebSocketReusable({ readyState: 1 } as never)).toBe(true);
    expect(isWebSocketReusable({ readyState: undefined } as never)).toBe(true);
    expect(isWebSocketReusable({ readyState: 3 } as never)).toBe(false);
  });
});

describe("buildWsTurnBody (delta / continuation)", () => {
  const continuation: WsContinuation = {
    lastBodyKey: wsBodyKey(mkBody([A])),
    lastInput: [A],
    lastResponseItems: [B],
    lastResponseId: "R1",
  };

  it("sends only the delta + previous_response_id when the prefix matches", () => {
    const out = buildWsTurnBody(mkBody([A, B, C]), continuation);
    expect(out.previous_response_id).toBe("R1");
    expect(out.input).toEqual([C]);
  });

  it("falls back to the full body when the prefix mismatches", () => {
    const out = buildWsTurnBody(mkBody([X, B, C]), continuation);
    expect(out.previous_response_id).toBeUndefined();
    expect(out.input).toEqual([X, B, C]);
  });

  it("falls back to full when the non-input body changed (system/tools)", () => {
    const out = buildWsTurnBody(mkBody([A, B, C], { instructions: "different" }), continuation);
    expect(out.previous_response_id).toBeUndefined();
  });

  it("falls back to full when history shrank below the baseline (compaction)", () => {
    const out = buildWsTurnBody(mkBody([A]), continuation);
    expect(out.previous_response_id).toBeUndefined();
    expect(out.input).toEqual([A]);
  });

  it("returns the body unchanged with no continuation", () => {
    const body = mkBody([A]);
    expect(buildWsTurnBody(body, null)).toBe(body);
  });
});
