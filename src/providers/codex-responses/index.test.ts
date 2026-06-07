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
    expect(headers["originator"]).toBe("swarm-harness");
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
});
