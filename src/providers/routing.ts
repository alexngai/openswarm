/**
 * Provider routing — resolve a model id to a ResolvedProvider.
 *
 * M4a Phase 4.1 / M4b Phase 2
 *
 * claude*                        → ClaudeAgentSdkEngine (SDK path)
 * gpt*, o1*, o3*, o4*, openai/* → OpenAITransportProvider (native path)
 * grok*                          → XaiTransportProvider (M4b)
 * gemini-*                       → GoogleTransportProvider (M4b)
 * qwen*, qwen/*, kimi*, kimi/*   → DashScopeTransportProvider (M4b)
 * everything else                → error (unknown prefix)
 */

import type { AuthSource } from "../auth/index.js";
import type { ResolvedProvider, Provider } from "./index.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";
import { OpenAICompatApiKeyAuth } from "../auth/openai-compat-api-key.js";

const KNOWN_PREFIXES = "claude*, gpt*, o1*, o3*, o4*, grok*, gemini-*, qwen*, kimi*, litellm/*, gateway/*, bedrock/*, azure/*";

export function resolveProvider(modelId: string): ResolvedProvider {
  // litellm/ | gateway/ | bedrock/ | azure/ → the LiteLLM gateway (OpenAI-compat). One endpoint, the
  // gateway routes the model name to Bedrock / Azure / open-weight; the prefix is a label (all go via the
  // gateway). Auth is self-described (LITELLM_API_KEY) since the stripped model name can't be pattern-matched.
  const gw = /^(litellm|gateway|bedrock|azure)\/(.+)$/i.exec(modelId);
  if (gw) {
    const cleanId = gw[2]!;
    return {
      kind: "native",
      providerFactory: async (auth: AuthSource, _id: string): Promise<Provider> => {
        const { LiteLLMTransportProvider } = await import("./litellm-transport.js");
        return await LiteLLMTransportProvider.create(auth, cleanId);
      },
      authFactory: () => new OpenAICompatApiKeyAuth("LITELLM_API_KEY", "litellm"),
      modelId: cleanId,
    };
  }

  // claude* → SDK engine
  if (/^claude/i.test(modelId)) {
    return {
      kind: "sdk",
      engineFactory: () => new ClaudeAgentSdkEngine(),
      modelId,
    };
  }

  // gpt*, o1*, o3*, o4*, openai/* → OpenAI via NativeEngine
  if (/^(gpt|o[134]|openai\/)/i.test(modelId)) {
    const cleanId = modelId.replace(/^openai\//, "");
    return {
      kind: "native",
      providerFactory: async (auth: AuthSource, _id: string): Promise<Provider> => {
        const { OpenAITransportProvider } = await import("./openai-transport.js");
        return await OpenAITransportProvider.create(auth, cleanId);
      },
      modelId: cleanId,
    };
  }

  // grok* → xAI
  if (/^grok/i.test(modelId)) {
    return {
      kind: "native",
      providerFactory: async (auth: AuthSource, _id: string): Promise<Provider> => {
        const { XaiTransportProvider } = await import("./xai-transport.js");
        return await XaiTransportProvider.create(auth, modelId);
      },
      modelId,
    };
  }

  // gemini-* → Google
  if (/^gemini-/i.test(modelId)) {
    return {
      kind: "native",
      providerFactory: async (auth: AuthSource, _id: string): Promise<Provider> => {
        const { GoogleTransportProvider } = await import("./google-transport.js");
        return await GoogleTransportProvider.create(auth, modelId);
      },
      modelId,
    };
  }

  // qwen* / qwen/* / kimi* / kimi/* → DashScope (OpenAI-compat)
  if (/^(qwen|kimi)([-/]|$)/i.test(modelId)) {
    const cleanId = modelId.replace(/^(qwen|kimi)\//, "");
    return {
      kind: "native",
      providerFactory: async (auth: AuthSource, _id: string): Promise<Provider> => {
        const { DashScopeTransportProvider } = await import("./dashscope-transport.js");
        return await DashScopeTransportProvider.create(auth, cleanId);
      },
      modelId: cleanId,
    };
  }

  return {
    kind: "error",
    message: `unknown model prefix "${modelId}". Known prefixes: ${KNOWN_PREFIXES}.`,
  };
}
