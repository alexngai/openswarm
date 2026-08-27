/**
 * DashScope preflight — enforces the 6 MB request body cap.
 *
 * Exported as a standalone helper so it can be tested independently
 * of DashScopeTransportProvider.
 */

import type { ProviderRequest } from "./index.js";
import type { ProviderError } from "../core/types.js";

export const DASHSCOPE_BODY_LIMIT = 6 * 1024 * 1024; // 6 MB

/**
 * Returns null if the estimated request body is within the limit,
 * or a ProviderError if it exceeds 6 MB.
 */
export function dashscopePreflight(req: ProviderRequest): ProviderError | null {
  const serialized = JSON.stringify({
    messages: req.messages,
    systemPrompt: req.systemPrompt,
    tools: req.tools,
  });
  const bytes = Buffer.byteLength(serialized, "utf8");

  if (bytes > DASHSCOPE_BODY_LIMIT) {
    return {
      code: "invalid_request",
      message: `DashScope request body exceeds 6 MB cap (${bytes} bytes > ${DASHSCOPE_BODY_LIMIT}). Reduce input.`,
      retryable: false,
    };
  }

  return null;
}
