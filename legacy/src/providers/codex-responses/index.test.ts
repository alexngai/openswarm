import { describe, it, expect, vi } from "vitest";
import { CodexResponsesTransportProvider, type CodexCredentialSource } from "./index.js";
import type { ProviderEvent, ProviderRequest } from "../index.js";

const creds: CodexCredentialSource = {
  getCredentials: async () => ({ token: "tok", accountId: "acc" }),
};

function sseResponse(frames: string[], init: { ok?: boolean; status?: number } = {}): Response {
  async function* body(): AsyncGenerator<Uint8Array> {
    const enc = new TextEncoder();
    for (const f of frames) yield enc.encode(f);
  }
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => frames.join(""),
    body: body(),
  } as unknown as Response;
}

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req: ProviderRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "ignored-overridden-by-provider",
  sessionId: "sess-1",
};

describe("CodexResponsesTransportProvider", () => {
  it("declares transport kind, codex id, and omits the AI-SDK model handle", () => {
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds });
    expect(p.kind).toBe("transport");
    expect(p.id).toBe("openai-codex");
    expect(p.model).toBeUndefined();
    expect(p.capabilities.reasoning).toBe(true);
  });

  it("streams a text turn end-to-end (fetch → SSE → ProviderEvents)", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      ]),
    );
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds, fetchImpl });
    const out = await collect(p.stream(req));
    expect(out).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "finish", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 1 } },
    ]);
  });

  it("sends the codex headers, the overridden model, and prompt_cache_key", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return sseResponse(['data: {"type":"response.completed","response":{}}\n\n']);
    }) as unknown as typeof fetch;
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds, fetchImpl });
    await collect(p.stream(req));

    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["chatgpt-account-id"]).toBe("acc");
    expect(headers["originator"]).toBe("openswarm");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("gpt-5.5"); // provider overrides req.model
    expect(body.store).toBe(false);
    expect(body.prompt_cache_key).toBe("sess-1");
  });

  it("classifies the model-gating 400 into an error event", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([JSON.stringify({ detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account." })], {
        ok: false,
        status: 400,
      }),
    );
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.4", credentials: creds, fetchImpl });
    const out = await collect(p.stream(req));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "error", code: "invalid_request", retryable: false });
    expect((out[0] as { message: string }).message).toContain("not supported");
  });

  it("surfaces the friendly rate-limit message (not the raw backend string)", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([JSON.stringify({ error: { code: "usage_limit_reached", message: "limit", plan_type: "Plus" } })], {
        ok: false,
        status: 429,
      }),
    );
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds, fetchImpl });
    const out = await collect(p.stream(req));
    expect(out[0]).toMatchObject({ type: "error", code: "rate_limit", retryable: true });
    expect((out[0] as { message: string }).message).toContain("hit your ChatGPT usage limit");
  });

  it("emits an auth error when credentials are unavailable", async () => {
    const failing: CodexCredentialSource = {
      getCredentials: async () => {
        throw new Error("not logged in");
      },
    };
    const fetchImpl = vi.fn();
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: failing, fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await collect(p.stream(req));
    expect(out[0]).toMatchObject({ type: "error", code: "auth" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits a retryable transport error when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds, fetchImpl });
    const out = await collect(p.stream(req));
    expect(out[0]).toMatchObject({ type: "error", code: "transport", retryable: true });
  });

  it("converts a mid-stream body failure into a retryable error event (not a throw)", async () => {
    function bodyThatThrows(): Response {
      async function* body(): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
        throw new Error("ECONNRESET mid-stream");
      }
      return { ok: true, status: 200, text: async () => "", body: body() } as unknown as Response;
    }
    const fetchImpl = vi.fn(async () => bodyThatThrows()) as unknown as typeof fetch;
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds, fetchImpl });
    const out = await collect(p.stream(req)); // must not throw
    expect(out[0]).toEqual({ type: "text-delta", text: "hi" });
    expect(out.at(-1)).toMatchObject({ type: "error", code: "transport", retryable: true });
  });

  it("emits a retryable error when the stream ends without a terminal event", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"type":"response.output_text.delta","delta":"hi"}\n\n']),
    ); // no response.completed
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds, fetchImpl });
    const out = await collect(p.stream(req));
    expect(out.at(-1)).toMatchObject({ type: "error", code: "transport", retryable: true });
    expect((out.at(-1) as { message: string }).message).toContain("without a terminal event");
  });

  it("forwards the abort signal to fetch", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new Error("AbortError");
      return sseResponse(['data: {"type":"response.completed","response":{}}\n\n']);
    }) as unknown as typeof fetch;
    const p = new CodexResponsesTransportProvider({ modelId: "gpt-5.5", credentials: creds, fetchImpl });
    const out = await collect(p.stream({ ...req, abort: ctrl.signal }));
    expect(out[0]).toMatchObject({ type: "error", code: "transport" });
  });
});

// Mock WebSocket that replies to each `send` with a canned Responses event
// sequence (delta turns, identified by previous_response_id, get a fresh id).
function makeMockSocket() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    readyState: 1,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
      const body = JSON.parse(data) as { previous_response_id?: string };
      const isDelta = body.previous_response_id !== undefined;
      const id = isDelta ? "R2" : "R1";
      const evts = [
        { type: "response.created", response: { id } },
        { type: "response.output_text.delta", delta: isDelta ? "B" : "A" },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1 } } },
      ];
      queueMicrotask(() => {
        for (const e of evts) (listeners["message"] ?? []).forEach((l) => l({ data: JSON.stringify(e) }));
      });
    },
    close() {
      this.readyState = 3;
    },
    addEventListener(t: string, l: (e: unknown) => void) {
      (listeners[t] ??= []).push(l);
    },
    removeEventListener(t: string, l: (e: unknown) => void) {
      listeners[t] = (listeners[t] ?? []).filter((x) => x !== l);
    },
  };
}

describe("CodexResponsesTransportProvider — WebSocket transport", () => {
  const user = (t: string) => ({ role: "user" as const, content: [{ type: "text" as const, text: t }] });

  it("streams a turn over WS with the full body (no previous_response_id)", async () => {
    const socket = makeMockSocket();
    let connects = 0;
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "websocket", sessionId: "s",
      wsConnectImpl: async () => { connects++; return socket as never; },
    });
    const out = await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    expect(out).toContainEqual({ type: "text-delta", text: "A" });
    expect(out.at(-1)).toMatchObject({ type: "finish" });
    const sent = JSON.parse(socket.sent[0]);
    expect(sent.type).toBe("response.create");
    expect(sent.previous_response_id).toBeUndefined();
    expect(connects).toBe(1);
    p.dispose();
  });

  it("sends only the delta + previous_response_id on turn 2, reusing the connection", async () => {
    const socket = makeMockSocket();
    let connects = 0;
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "websocket", sessionId: "s",
      wsConnectImpl: async () => { connects++; return socket as never; },
    });
    await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    await collect(p.stream({
      messages: [user("hi"), { role: "assistant", content: [{ type: "text", text: "A" }] }, user("more")],
      model: "gpt-5.5", sessionId: "s",
    }));
    expect(connects).toBe(1); // connection reused across turns
    const turn2 = JSON.parse(socket.sent[1]);
    expect(turn2.previous_response_id).toBe("R1");
    expect(turn2.input).toHaveLength(1); // only the new user message, not the full history
    expect(turn2.input[0]).toMatchObject({ type: "message", role: "user" });
    p.dispose();
  });

  it("keeps the delta across a reasoning turn (continuation baseline matches the replay)", async () => {
    // Settles the id-keep-vs-strip question: lastResponseItems and the next-turn
    // replay both run assistantContentToCodexInput→parseReasoningSignature (id
    // stripped on BOTH sides), so the prefix should match → delta, not full body.
    const reasoningItem = { id: "rs_1", type: "reasoning", encrypted_content: "ENC", summary: [] as unknown[] };
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const socket = {
      readyState: 1,
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data);
        const body = JSON.parse(data) as { previous_response_id?: string };
        const id = body.previous_response_id ? "R2" : "R1";
        const evts = [
          { type: "response.created", response: { id } },
          ...(body.previous_response_id ? [] : [{ type: "response.output_item.done", item: reasoningItem }]),
          { type: "response.output_text.delta", delta: body.previous_response_id ? "B" : "A" },
          { type: "response.completed", response: { id, usage: {} } },
        ];
        queueMicrotask(() => {
          for (const e of evts) (listeners["message"] ?? []).forEach((l) => l({ data: JSON.stringify(e) }));
        });
      },
      close() { this.readyState = 3; },
      addEventListener(t: string, l: (e: unknown) => void) { (listeners[t] ??= []).push(l); },
      removeEventListener(t: string, l: (e: unknown) => void) { listeners[t] = (listeners[t] ?? []).filter((x) => x !== l); },
    };
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "websocket", sessionId: "s",
      wsConnectImpl: async () => socket as never,
    });
    await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    await collect(p.stream({
      messages: [
        user("hi"),
        { role: "assistant", content: [{ type: "reasoning", signature: JSON.stringify(reasoningItem) }, { type: "text", text: "A" }] },
        user("more"),
      ],
      model: "gpt-5.5", sessionId: "s",
    }));
    const turn2 = JSON.parse(socket.sent[1]);
    expect(turn2.previous_response_id).toBe("R1"); // delta survived the reasoning turn
    expect(turn2.input).toHaveLength(1);
    p.dispose();
  });

  it("records the response id from response.completed (not a stale created id)", async () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const socket = {
      readyState: 1,
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data);
        const body = JSON.parse(data) as { previous_response_id?: string };
        const evts = body.previous_response_id
          ? [{ type: "response.created", response: { id: "RC2" } }, { type: "response.completed", response: { id: "RD2", usage: {} } }]
          : [{ type: "response.created", response: { id: "RC1" } }, { type: "response.completed", response: { id: "RD1", usage: {} } }];
        queueMicrotask(() => {
          for (const e of evts) (listeners["message"] ?? []).forEach((l) => l({ data: JSON.stringify(e) }));
        });
      },
      close() { this.readyState = 3; },
      addEventListener(t: string, l: (e: unknown) => void) { (listeners[t] ??= []).push(l); },
      removeEventListener(t: string, l: (e: unknown) => void) { listeners[t] = (listeners[t] ?? []).filter((x) => x !== l); },
    };
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "websocket", sessionId: "s",
      wsConnectImpl: async () => socket as never,
    });
    await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    await collect(p.stream({
      messages: [user("hi"), { role: "assistant", content: [{ type: "text", text: "A" }] }, user("more")],
      model: "gpt-5.5", sessionId: "s",
    }));
    // previous_response_id must be the COMPLETED id (RD1), not the created id (RC1).
    expect(JSON.parse(socket.sent[1]).previous_response_id).toBe("RD1");
    p.dispose();
  });

  it("yields a transport error when send() throws (dead socket)", async () => {
    const socket = {
      readyState: 1,
      send() { throw new Error("socket closed"); },
      close() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "websocket",
      wsConnectImpl: async () => socket as never,
    });
    const out = await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    expect(out[0]).toMatchObject({ type: "error", code: "transport" });
    p.dispose();
  });

  it("auto mode falls back to SSE when send() throws", async () => {
    const socket = {
      readyState: 1,
      send() { throw new Error("socket closed"); },
      close() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"type":"response.completed","response":{}}\n\n']));
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "auto", fetchImpl,
      wsConnectImpl: async () => socket as never,
    });
    const out = await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(out.at(-1)).toMatchObject({ type: "finish" });
  });

  it("auto mode falls back to SSE when the WS connection fails", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"type":"response.completed","response":{}}\n\n']));
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "auto", fetchImpl,
      wsConnectImpl: async () => { throw new Error("no ws"); },
    });
    const out = await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(out.at(-1)).toMatchObject({ type: "finish" });
  });

  it("websocket mode (no fallback) yields a transport error when the WS connection fails", async () => {
    const fetchImpl = vi.fn();
    const p = new CodexResponsesTransportProvider({
      modelId: "gpt-5.5", credentials: creds, transport: "websocket",
      fetchImpl: fetchImpl as never,
      wsConnectImpl: async () => { throw new Error("no ws"); },
    });
    const out = await collect(p.stream({ messages: [user("hi")], model: "gpt-5.5", sessionId: "s" }));
    expect(out[0]).toMatchObject({ type: "error", code: "transport" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
