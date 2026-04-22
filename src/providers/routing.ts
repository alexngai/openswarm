/**
 * Provider routing — resolve a model id to a ResolvedProvider.
 *
 * M4a Phase 4.1
 *
 * claude*          → ClaudeAgentSdkEngine (SDK path)
 * gpt*, o1*, o3*, o4*, openai/* → OpenAITransportProvider (native path)
 * grok*, gemini*, qwen*, kimi* → error (M4b pending)
 * everything else  → error (unknown prefix)
 */

import type { AuthSource } from "../auth/index.js";
import type { ResolvedProvider, Provider } from "./index.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";

const KNOWN_PREFIXES_M4A = "claude*, gpt*, o1*, o3*, o4*";
const KNOWN_PREFIXES_M4B_PENDING = /^(grok|gemini|qwen|kimi)/i;

export function resolveProvider(modelId: string): ResolvedProvider {
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

  // M4b-pending providers → explicit error pointing at M4b
  if (KNOWN_PREFIXES_M4B_PENDING.test(modelId)) {
    return {
      kind: "error",
      message: `model "${modelId}" — xAI/Google/DashScope/Moonshot land in M4b. Known prefixes in M4a: ${KNOWN_PREFIXES_M4A}.`,
    };
  }

  return {
    kind: "error",
    message: `unknown model prefix "${modelId}". Known prefixes: ${KNOWN_PREFIXES_M4A} (M4a).`,
  };
}
