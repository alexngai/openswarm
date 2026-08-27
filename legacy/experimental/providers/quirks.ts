/**
 * Model-family quirks — centralised detection + application.
 *
 * Each provider (OpenAI, xAI, Google, DashScope, Codex-ChatGPT) calls
 * `resolveQuirks(canonicalModel)` to get the set of applicable quirk tags,
 * then `applyQuirks(body, tags)` to mutate a shallow copy before wire
 * serialization.
 *
 * M4b Phase 6: centralised. Existing providers can migrate to consume
 * these helpers in a follow-up; this phase only provides the API.
 */

export type QuirkTag =
  | "strip-reasoning-params"  // o1*, o3*, o4*, *-thinking, qwq*, grok-3-mini — drop temperature, topP, topK, presencePenalty, frequencyPenalty
  | "max-completion-tokens"   // gpt-5* — rename maxOutputTokens → maxCompletionTokens
  | "strip-is-error";         // kimi* — drop `is_error` field from tool_result content blocks

/**
 * Resolve the quirk tags for a canonical model id.
 *
 * Patterns (case-insensitive):
 *   - /^o[134]($|-)/, /-thinking$/, /^qwq/, /^grok-3-mini$/ → "strip-reasoning-params"
 *   - /^gpt-5(-|$)/ → "max-completion-tokens"
 *   - /^kimi/ → "strip-is-error"
 *
 * Multiple tags can apply to the same model (e.g. a future "kimi-thinking"
 * would get both strip-is-error and strip-reasoning-params).
 */
export function resolveQuirks(canonicalModel: string): readonly QuirkTag[] {
  const tags: QuirkTag[] = [];

  if (
    /^o[134]($|-)/i.test(canonicalModel) ||
    /-thinking/i.test(canonicalModel) ||
    /^qwq/i.test(canonicalModel) ||
    /^grok-3-mini$/i.test(canonicalModel)
  ) {
    tags.push("strip-reasoning-params");
  }

  if (/^gpt-5(-|$)/i.test(canonicalModel)) {
    tags.push("max-completion-tokens");
  }

  if (/^kimi/i.test(canonicalModel)) {
    tags.push("strip-is-error");
  }

  return Object.freeze(tags);
}

/**
 * Request-body shape that applyQuirks operates on. Structurally matches
 * what each TransportProvider builds before calling the Vercel AI SDK.
 */
export interface QuirkRequestBody {
  messages?: readonly unknown[];
  maxOutputTokens?: number;
  maxCompletionTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  [k: string]: unknown;
}

/**
 * Apply quirks to a shallow-copy of the body. Idempotent:
 * applyQuirks(applyQuirks(body, tags), tags) === applyQuirks(body, tags).
 *
 * - "strip-reasoning-params": delete temperature, topP, topK, presencePenalty,
 *   frequencyPenalty (if present).
 * - "max-completion-tokens": rename maxOutputTokens → maxCompletionTokens
 *   (move value; leave maxCompletionTokens untouched if already set).
 * - "strip-is-error": walk `messages`; for each user message with
 *   tool_result-shaped blocks, strip the `is_error` key from each block.
 *   (Only applies to the shape defined in src/providers/index.ts
 *   ProviderMessage — `messages` is `readonly ProviderMessage[]` in practice,
 *   but we type it as `readonly unknown[]` for defensive narrowing.)
 */
export function applyQuirks<T extends QuirkRequestBody>(
  body: T,
  tags: readonly QuirkTag[],
): T {
  const result: T = { ...body };

  if (tags.includes("strip-reasoning-params")) {
    delete result.temperature;
    delete result.topP;
    delete result.topK;
    delete result.presencePenalty;
    delete result.frequencyPenalty;
  }

  if (tags.includes("max-completion-tokens")) {
    if (result.maxOutputTokens !== undefined && result.maxCompletionTokens === undefined) {
      result.maxCompletionTokens = result.maxOutputTokens;
    }
    delete result.maxOutputTokens;
  }

  if (tags.includes("strip-is-error") && result.messages !== undefined) {
    result.messages = result.messages.map((msg) => {
      if (
        typeof msg !== "object" ||
        msg === null ||
        (msg as Record<string, unknown>)["role"] !== "user"
      ) {
        return msg;
      }
      const msgObj = msg as Record<string, unknown>;
      const content = msgObj["content"];
      if (!Array.isArray(content)) {
        return msg;
      }
      const newContent = content.map((block: unknown) => {
        if (
          typeof block !== "object" ||
          block === null ||
          (block as Record<string, unknown>)["type"] !== "tool_result" ||
          !("is_error" in (block as Record<string, unknown>))
        ) {
          return block;
        }
        const { is_error: _dropped, ...rest } = block as Record<string, unknown>;
        return rest;
      });
      return { ...msgObj, content: newContent };
    });
  }

  return result;
}
