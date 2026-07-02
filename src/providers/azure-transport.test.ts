/**
 * Tests for AzureTransportProvider (Phase 4.2 — was zero-coverage).
 *
 * Covers the exported env helpers, the api-version/api-key fetch wrapper, the
 * create() guards, and stream() event mapping (ai.streamText mocked).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: vi.fn() };
});

import {
  AzureTransportProvider,
  azureApiBaseFromEnv,
  azureApiVersionFromEnv,
  azureFetch,
} from "./azure-transport.js";
import type { AuthSource } from "../auth/index.js";
import type { ProviderRequest } from "./index.js";
import { streamText } from "ai";

const authOk: AuthSource = { isAuthenticated: async () => true };
const authNo: AuthSource = { isAuthenticated: async () => false };

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { messages: [], model: "gpt-4.1", ...overrides };
}

async function* asyncIterOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

const finishPart = {
  type: "finish",
  finishReason: "stop",
  totalUsage: { inputTokens: 5, outputTokens: 3, inputTokenDetails: {}, outputTokenDetails: {} },
};

// ---------------------------------------------------------------------------
// env helpers
// ---------------------------------------------------------------------------

describe("azureApiBaseFromEnv", () => {
  it("reads AZURE_API_BASE and trims a trailing slash", () => {
    expect(azureApiBaseFromEnv({ AZURE_API_BASE: "https://r.openai.azure.com/" })).toBe(
      "https://r.openai.azure.com",
    );
  });
  it("falls back to AZURE_OPENAI_ENDPOINT", () => {
    expect(
      azureApiBaseFromEnv({ AZURE_OPENAI_ENDPOINT: "https://alt.openai.azure.com" }),
    ).toBe("https://alt.openai.azure.com");
  });
  it("returns undefined when neither is set", () => {
    expect(azureApiBaseFromEnv({})).toBeUndefined();
  });
});

describe("azureApiVersionFromEnv", () => {
  it("defaults when unset", () => {
    expect(azureApiVersionFromEnv({})).toBe("2024-08-01-preview");
  });
  it("honors an explicit version", () => {
    expect(azureApiVersionFromEnv({ AZURE_OPENAI_API_VERSION: "2025-01-01" })).toBe(
      "2025-01-01",
    );
  });
});

// ---------------------------------------------------------------------------
// azureFetch wrapper
// ---------------------------------------------------------------------------

describe("azureFetch", () => {
  let calls: Array<{ url: string; headers: Headers }>;
  let orig: typeof globalThis.fetch;

  beforeEach(() => {
    calls = [];
    orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("injects the api-version query param and the api-key header, dropping authorization", async () => {
    const f = azureFetch("2024-08-01-preview", "secret-key");
    await f("https://r.openai.azure.com/openai/deployments/gpt-4.1/chat/completions", {
      headers: { authorization: "Bearer leak" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("api-version=2024-08-01-preview");
    expect(calls[0]!.headers.get("api-key")).toBe("secret-key");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("does not override an existing api-version param", async () => {
    const f = azureFetch("2024-08-01-preview", "k");
    await f("https://r.openai.azure.com/x?api-version=2099-12-31");
    expect(calls[0]!.url).toContain("api-version=2099-12-31");
    expect(calls[0]!.url).not.toContain("2024-08-01-preview");
  });
});

// ---------------------------------------------------------------------------
// create() guards
// ---------------------------------------------------------------------------

describe("AzureTransportProvider.create()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("throws when the endpoint base is missing", async () => {
    vi.stubEnv("AZURE_API_BASE", "");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "");
    await expect(AzureTransportProvider.create(authOk, "gpt-4.1")).rejects.toThrow(
      /requires AZURE_API_BASE/,
    );
  });

  it("throws when unauthenticated (no api-key)", async () => {
    vi.stubEnv("AZURE_API_BASE", "https://r.openai.azure.com");
    await expect(AzureTransportProvider.create(authNo, "gpt-4.1")).rejects.toThrow(
      /requires AZURE_OPENAI_API_KEY/,
    );
  });

  it("returns a provider with azure id + transport kind when configured", async () => {
    vi.stubEnv("AZURE_API_BASE", "https://r.openai.azure.com");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "azkey");
    const p = await AzureTransportProvider.create(authOk, "gpt-4.1");
    expect(p.id).toBe("azure");
    expect(p.kind).toBe("transport");
    expect(p.capabilities.streaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stream() event mapping
// ---------------------------------------------------------------------------

describe("AzureTransportProvider.stream()", () => {
  beforeEach(() => {
    vi.stubEnv("AZURE_API_BASE", "https://r.openai.azure.com");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "azkey");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("maps text-delta, tool-call, and finish parts to ProviderEvents", async () => {
    const parts = [
      { type: "text-delta", id: "t1", text: "hello" },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
      finishPart,
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const p = await AzureTransportProvider.create(authOk, "gpt-4.1");
    const events = [];
    for await (const e of p.stream(makeReq())) events.push(e);

    expect(events[0]).toEqual({ type: "text-delta", text: "hello" });
    expect(events[1]).toEqual({ type: "tool-call", id: "c1", name: "bash", input: { cmd: "ls" } });
    expect(events[2]).toMatchObject({ type: "finish", stopReason: "end_turn" });
  });

  it("maps an error part through the shared classifier", async () => {
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf([{ type: "error", error: new Error("boom") }]),
    });
    const p = await AzureTransportProvider.create(authOk, "gpt-4.1");
    const events = [];
    for await (const e of p.stream(makeReq())) events.push(e);
    expect(events[0]).toMatchObject({ type: "error" });
  });
});
