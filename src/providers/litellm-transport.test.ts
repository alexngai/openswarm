import { describe, expect, it } from "vitest";
import { liteLLMExtraBodyFromEnv, mergeLiteLLMExtraBody } from "./litellm-transport";

describe("LiteLLMTransportProvider request body extras", () => {
  it("omits extra body when LITELLM_EXTRA_BODY is empty", () => {
    expect(liteLLMExtraBodyFromEnv({})).toBeUndefined();
    expect(liteLLMExtraBodyFromEnv({ LITELLM_EXTRA_BODY: "   " })).toBeUndefined();
  });

  it("parses LITELLM_EXTRA_BODY as a JSON object", () => {
    expect(
      liteLLMExtraBodyFromEnv({
        LITELLM_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}',
      }),
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("rejects non-object LITELLM_EXTRA_BODY values", () => {
    expect(() => liteLLMExtraBodyFromEnv({ LITELLM_EXTRA_BODY: "[]" })).toThrow(
      "LITELLM_EXTRA_BODY must be a JSON object",
    );
  });

  it("merges extra fields into JSON request bodies", () => {
    const merged = mergeLiteLLMExtraBody(
      '{"model":"qwen","temperature":0}',
      { chat_template_kwargs: { enable_thinking: false } },
    );

    expect(JSON.parse(String(merged))).toEqual({
      model: "qwen",
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});
