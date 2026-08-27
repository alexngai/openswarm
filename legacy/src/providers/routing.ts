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
 * awsbedrock/*                   → BedrockTransportProvider (native Converse, bearer token)
 * everything else                → error (unknown prefix)
 */

import type { AuthSource } from "../auth/index.js";
import type { ResolvedProvider, Provider } from "./index.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";
import { OpenAICompatApiKeyAuth } from "../auth/openai-compat-api-key.js";

const KNOWN_PREFIXES = "claude*, gpt*, o1*, o3*, o4*, grok*, gemini-*, qwen*, kimi*, litellm/*, gateway/*, bedrock/*, azure/*, azureoai/*, awsbedrock/*";

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

  // azureoai/<deployment> → Azure OpenAI DIRECT (no gateway). Distinct from the azure/ prefix above
  // (which routes to the LiteLLM gateway). The stripped value is the Azure deployment name (e.g.
  // gpt-4.1). Auth is the Azure resource api-key (AZURE_OPENAI_API_KEY), sent as the api-key header.
  const azureOai = /^azureoai\/(.+)$/i.exec(modelId);
  if (azureOai) {
    const deployment = azureOai[1]!;
    return {
      kind: "native",
      providerFactory: async (auth: AuthSource, _id: string): Promise<Provider> => {
        const { AzureTransportProvider } = await import("./azure-transport.js");
        return await AzureTransportProvider.create(auth, deployment);
      },
      authFactory: () => new OpenAICompatApiKeyAuth("AZURE_OPENAI_API_KEY", "azure"),
      modelId: deployment,
    };
  }

  // awsbedrock/<id> → AWS Bedrock DIRECT via the native Converse API (open-weight Llama / Nova).
  // Distinct from the bedrock/ prefix above (which routes to the LiteLLM gateway). The stripped value
  // is the Bedrock inference-profile model id (e.g. us.meta.llama3-1-8b-instruct-v1:0). Auth is the
  // bearer token AWS_BEARER_TOKEN_BEDROCK (no AWS SigV4 keys required).
  const awsBedrock = /^awsbedrock\/(.+)$/i.exec(modelId);
  if (awsBedrock) {
    const cleanId = awsBedrock[1]!;
    return {
      kind: "native",
      providerFactory: async (auth: AuthSource, _id: string): Promise<Provider> => {
        const { BedrockTransportProvider } = await import("./bedrock-transport.js");
        return await BedrockTransportProvider.create(auth, cleanId);
      },
      authFactory: () => new OpenAICompatApiKeyAuth("AWS_BEARER_TOKEN_BEDROCK", "bedrock"),
      modelId: cleanId,
    };
  }

  // claude* (direct) OR an Amazon Bedrock / Vertex Anthropic inference-profile id (e.g.
  // us.anthropic.claude-sonnet-4-5-20250929-v1:0) → Claude Agent SDK, which talks to Bedrock/Vertex
  // itself via CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX. The `bedrock/` | `gateway/` | `litellm/`
  // prefixes are matched above (LiteLLM gateway) and take precedence.
  if (/^claude/i.test(modelId) || /anthropic\.claude/i.test(modelId)) {
    return {
      kind: "sdk",
      engineFactory: (opts) => new ClaudeAgentSdkEngine(opts),
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
      authFactory: async () => {
        const { XaiApiKeyAuth } = await import("../auth/xai-api-key.js");
        return new XaiApiKeyAuth();
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
      authFactory: async () => {
        const { GoogleApiKeyAuth } = await import("../auth/google-api-key.js");
        return new GoogleApiKeyAuth();
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
      authFactory: () => new OpenAICompatApiKeyAuth("DASHSCOPE_API_KEY", "dashscope"),
      modelId: cleanId,
    };
  }

  return {
    kind: "error",
    message: `unknown model prefix "${modelId}". Known prefixes: ${KNOWN_PREFIXES}.`,
  };
}
