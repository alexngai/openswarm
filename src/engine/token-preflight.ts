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
 * Attempt a server-side token count via the Anthropic REST API.
 *
 * Requires `ANTHROPIC_API_KEY` in the environment. Returns undefined when:
 *   - No API key is set (Claude Max subscription users go through OAuth, not
 *     API key, so the count_tokens endpoint returns 401 for them).
 *   - The network call fails for any reason.
 *
 * Callers should fall back to `localEstimate` when this returns undefined.
 *
 * NOTE (v0.2.Q6 A8): This path is only exercised when `ANTHROPIC_API_KEY` is
 * present. Claude Max subscription users will always hit the local-estimate
 * path. If the Anthropic Agent SDK ever exposes a native token-count method
 * that works with OAuth/subscription auth, prefer it here.
 */
export async function serverCountTokens(
  input: CountTokensInput,
): Promise<CountTokensResult | undefined> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return undefined;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    // Build the params for the count_tokens endpoint.
    // Our internal messages shape is structurally compatible at runtime;
    // cast through unknown to satisfy the SDK's ContentBlockParam[] constraint.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = input.messages as unknown as any[];
    const model = (input.model as string | undefined) ?? "claude-sonnet-4-5";

    const result = await client.messages.countTokens({
      model,
      messages,
      ...(input.systemPrompt !== undefined && {
        system: Array.isArray(input.systemPrompt)
          ? input.systemPrompt.join("\n")
          : (input.systemPrompt as string),
      }),
    });

    return { inputTokens: result.input_tokens, source: "server" };
  } catch {
    // Network failure, auth error, or missing SDK — fall through to local estimate.
    return undefined;
  }
}

/**
 * Best-effort token counter.
 *
 * Uses server-side count (Anthropic `count_tokens` REST endpoint) when
 * `ANTHROPIC_API_KEY` is set in the environment. Falls back to the local
 * character-length heuristic when no API key is available (e.g. Claude Max
 * subscription users) or when the server call fails.
 *
 * v0.2.Q6 (A8): server path wired; gated on ANTHROPIC_API_KEY presence.
 * Claude Max subscription users always get `source: "local-estimate"`.
 */
export async function countTokens(
  input: CountTokensInput,
): Promise<CountTokensResult> {
  const server = await serverCountTokens(input);
  return server ?? localEstimate(input);
}
