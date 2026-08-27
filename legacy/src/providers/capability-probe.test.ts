import { describe, it, expect } from "vitest";
import {
  applyProbedCapabilities,
  capabilitiesFromEnv,
  probeOpenAICompatCapabilities,
  MAX_CONTEXT_ENV,
  MAX_OUTPUT_ENV,
  PROBE_ENABLED_ENV,
} from "./capability-probe.js";

/** Minimal fetch double: url → JSON body, or a thrown error. */
function fakeFetch(
  routes: Record<string, unknown | Error>,
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = routes[url];
    if (hit === undefined) {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    if (hit instanceof Error) throw hit;
    return { ok: true, status: 200, json: async () => hit } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = "http://vllm:8000/v1";

describe("capabilitiesFromEnv", () => {
  it("returns undefined when neither override is set", () => {
    expect(capabilitiesFromEnv({})).toBeUndefined();
  });

  it("reads both overrides", () => {
    expect(
      capabilitiesFromEnv({
        [MAX_CONTEXT_ENV]: "32768",
        [MAX_OUTPUT_ENV]: "4096",
      }),
    ).toEqual({ maxContextTokens: 32768, maxOutputTokens: 4096, source: "env" });
  });

  it("ignores non-positive or malformed values", () => {
    expect(capabilitiesFromEnv({ [MAX_CONTEXT_ENV]: "0" })).toBeUndefined();
    expect(capabilitiesFromEnv({ [MAX_CONTEXT_ENV]: "abc" })).toBeUndefined();
  });
});

describe("probeOpenAICompatCapabilities", () => {
  it("prefers the env override over any network call", async () => {
    const { impl, calls } = fakeFetch({});
    const out = await probeOpenAICompatCapabilities({
      baseURL: BASE,
      modelId: "m",
      fetchImpl: impl,
      env: { [MAX_CONTEXT_ENV]: "16384" },
    });
    expect(out).toEqual({ maxContextTokens: 16384, source: "env" });
    expect(calls).toEqual([]);
  });

  it("reads vLLM's max_model_len from /models", async () => {
    const { impl } = fakeFetch({
      [`${BASE}/models`]: {
        object: "list",
        data: [{ id: "Qwen/Qwen3-30B", object: "model", max_model_len: 32768 }],
      },
    });
    const out = await probeOpenAICompatCapabilities({
      baseURL: BASE,
      modelId: "Qwen/Qwen3-30B",
      fetchImpl: impl,
      env: {},
    });
    expect(out).toEqual({ maxContextTokens: 32768, source: "models-endpoint" });
  });

  it("matches a single-model server even when the id was aliased", async () => {
    const { impl } = fakeFetch({
      [`${BASE}/models`]: {
        data: [{ id: "/models/local-weights", max_model_len: 8192 }],
      },
    });
    const out = await probeOpenAICompatCapabilities({
      baseURL: BASE,
      modelId: "my-alias",
      fetchImpl: impl,
      env: {},
    });
    expect(out.maxContextTokens).toBe(8192);
  });

  it("does not guess when several models are listed and none match", async () => {
    const { impl } = fakeFetch({
      [`${BASE}/models`]: {
        data: [
          { id: "a", max_model_len: 1000 },
          { id: "b", max_model_len: 2000 },
        ],
      },
    });
    const out = await probeOpenAICompatCapabilities({
      baseURL: BASE,
      modelId: "c",
      fetchImpl: impl,
      env: {},
    });
    expect(out.source).toBe("none");
  });

  it("falls back to LiteLLM's /model/info when /models carries no limits", async () => {
    const { impl, calls } = fakeFetch({
      [`${BASE}/models`]: { data: [{ id: "gpt-oss-20b", object: "model" }] },
      "http://vllm:8000/model/info": {
        data: [
          {
            model_name: "gpt-oss-20b",
            model_info: { max_input_tokens: 65536, max_output_tokens: 4096 },
          },
        ],
      },
    });
    const out = await probeOpenAICompatCapabilities({
      baseURL: BASE,
      modelId: "gpt-oss-20b",
      fetchImpl: impl,
      env: {},
    });
    expect(out).toEqual({
      maxContextTokens: 65536,
      maxOutputTokens: 4096,
      source: "model-info-endpoint",
    });
    expect(calls).toContain("http://vllm:8000/model/info");
  });

  it("never throws when the endpoint is unreachable", async () => {
    const { impl } = fakeFetch({
      [`${BASE}/models`]: new Error("ECONNREFUSED"),
      "http://vllm:8000/model/info": new Error("ECONNREFUSED"),
    });
    const out = await probeOpenAICompatCapabilities({
      baseURL: BASE,
      modelId: "m",
      fetchImpl: impl,
      env: {},
    });
    expect(out).toEqual({ source: "none" });
  });

  it("skips the network entirely when the probe is disabled", async () => {
    const { impl, calls } = fakeFetch({});
    const out = await probeOpenAICompatCapabilities({
      baseURL: BASE,
      modelId: "m",
      fetchImpl: impl,
      env: { [PROBE_ENABLED_ENV]: "0" },
    });
    expect(out).toEqual({ source: "none" });
    expect(calls).toEqual([]);
  });

  it("returns none for an empty base URL", async () => {
    const { impl } = fakeFetch({});
    const out = await probeOpenAICompatCapabilities({
      baseURL: "",
      modelId: "m",
      fetchImpl: impl,
      env: {},
    });
    expect(out).toEqual({ source: "none" });
  });
});

describe("applyProbedCapabilities", () => {
  const baseline = { maxContextTokens: 200_000, maxOutputTokens: 8_192, other: true };

  it("keeps the baseline when nothing was probed", () => {
    expect(applyProbedCapabilities(baseline, { source: "none" })).toEqual(baseline);
  });

  it("replaces the guessed context window", () => {
    const out = applyProbedCapabilities(baseline, {
      maxContextTokens: 32_768,
      source: "models-endpoint",
    });
    expect(out.maxContextTokens).toBe(32_768);
    expect(out.maxOutputTokens).toBe(8_192);
  });

  it("clamps the output cap to the discovered window", () => {
    const out = applyProbedCapabilities(baseline, {
      maxContextTokens: 4_096,
      source: "models-endpoint",
    });
    // An 8k output cap against a 4k window would over-request.
    expect(out.maxOutputTokens).toBe(4_096);
  });

  it("preserves unrelated capability fields", () => {
    const out = applyProbedCapabilities(baseline, {
      maxContextTokens: 1_000,
      source: "env",
    });
    expect(out.other).toBe(true);
  });
});
