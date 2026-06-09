import { describe, it, expect } from "vitest";
import {
  resolveCodexWsUrl,
  buildCodexWsHeaders,
  buildWsTurnBody,
  wsBodyKey,
  isWebSocketReusable,
  parseCodexWs,
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

function fakeSocket() {
  const L: Record<string, ((e: unknown) => void)[]> = {};
  const socket = {
    readyState: 1,
    send() {},
    close() {},
    addEventListener(t: string, l: (e: unknown) => void) {
      (L[t] ??= []).push(l);
    },
    removeEventListener(t: string, l: (e: unknown) => void) {
      L[t] = (L[t] ?? []).filter((x) => x !== l);
    },
  };
  return { socket, emit: (t: string, e: unknown) => (L[t] ?? []).forEach((l) => l(e)) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("parseCodexWs", () => {
  it("fails the stream on a malformed frame (does not silently drop it)", async () => {
    const { socket, emit } = fakeSocket();
    const first = parseCodexWs(socket as never).next();
    await tick();
    emit("message", { data: "{bad json" });
    await expect(first).rejects.toThrow(/malformed/);
  });

  it("decodes an ArrayBuffer (binary) frame", async () => {
    const { socket, emit } = fakeSocket();
    const it = parseCodexWs(socket as never);
    const first = it.next();
    await tick();
    emit("message", { data: new TextEncoder().encode('{"type":"response.completed","response":{}}').buffer });
    expect((await first).value).toMatchObject({ type: "response.completed" });
  });

  it("ignores an empty keep-alive frame", async () => {
    const { socket, emit } = fakeSocket();
    const it = parseCodexWs(socket as never);
    const first = it.next();
    await tick();
    emit("message", { data: "   " }); // ignored
    emit("message", { data: '{"type":"response.completed","response":{}}' });
    expect((await first).value).toMatchObject({ type: "response.completed" });
  });

  it("rejects when aborted mid-stream", async () => {
    const { socket } = fakeSocket();
    const ac = new AbortController();
    const first = parseCodexWs(socket as never, ac.signal).next();
    await tick();
    ac.abort();
    await expect(first).rejects.toThrow(/aborted/);
  });

  it("rejects when the socket closes before completion", async () => {
    const { socket, emit } = fakeSocket();
    const first = parseCodexWs(socket as never).next();
    await tick();
    emit("close", {});
    await expect(first).rejects.toThrow(/closed before completion/);
  });
});
