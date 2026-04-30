import type { CountTokensInput, CountTokensResult } from "./index.js";

export function localEstimate(input: CountTokensInput): CountTokensResult {
  const json = JSON.stringify({
    system: input.systemPrompt,
    messages: input.messages,
    tools: input.tools,
  });
  // 2.5 chars/token conservative heuristic — rounds up so callers see
  // worst-case preflight, not a false-negative that overshoots context.
  return { inputTokens: Math.ceil(json.length / 2.5), source: "local-estimate" };
}

/**
 * Best-effort token counter. M3b Phase 7 ships local estimate only.
 *
 * Notes for M4+:
 *   - If the SDK gains a native count method (query().count_tokens or
 *     similar), prefer it and record `source: "server"`.
 *   - Direct REST to the Anthropic count_tokens endpoint requires API-key
 *     auth and 401s under Claude Max subscription — out of scope.
 */
export async function countTokens(
  input: CountTokensInput,
): Promise<CountTokensResult> {
  return localEstimate(input);
}
