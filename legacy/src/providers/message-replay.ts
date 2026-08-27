/**
 * message-replay — converts our ProviderMessage history to the Vercel AI SDK
 * v6 ModelMessage shape consumed by streamText().
 *
 * Translation rules:
 *   system   → { role: "system", content: text-concatenation }
 *   user (text-only) → { role: "user", content: "text" }
 *   user (tool_result-only) → { role: "tool", content: [tool-result blocks] }
 *   user (mixed) → two messages: user text first, then tool role
 *   assistant (text-only) → { role: "assistant", content: "text" }
 *   assistant (tool_use) → { role: "assistant", content: [text + tool-call blocks] }
 *
 * Guard: a tool_result block without a preceding assistant tool_use in the
 * session is a compactor bug — throw to surface it early.
 */

import type { ModelMessage } from "ai";
import type { ProviderMessage } from "./index.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ToolResultContent = {
  type: "tool-result";
  toolCallId: string;
  // AI SDK v6 ToolResultPart REQUIRES toolName — omitting it fails ModelMessage[] schema validation
  // (AI_InvalidPromptError) the moment a tool_result enters history, breaking the multi-turn tool loop.
  toolName: string;
  output: { type: "text"; value: string };
};

function systemToModel(
  msg: Extract<ProviderMessage, { role: "system" }>
): ModelMessage {
  const text = msg.content.map((c) => c.text).join("");
  return { role: "system", content: text };
}

function userToModel(
  msg: Extract<ProviderMessage, { role: "user" }>,
  toolUseNames: Map<string, string>
): ModelMessage[] {
  const textBlocks = msg.content.filter((c) => c.type === "text") as Array<{
    type: "text";
    text: string;
  }>;
  const toolResultBlocks = msg.content.filter(
    (c) => c.type === "tool_result"
  ) as Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;

  // Guard: tool_result without a corresponding tool_use
  for (const tr of toolResultBlocks) {
    if (!toolUseNames.has(tr.tool_use_id)) {
      throw new Error(
        `[message-replay] tool_result references tool_use_id "${tr.tool_use_id}" ` +
          `but no matching assistant tool_use was found in the session. ` +
          `This indicates a compactor bug — the boundary walk-back should have kept the pair.`
      );
    }
  }

  const results: ModelMessage[] = [];

  if (textBlocks.length > 0) {
    const text = textBlocks.map((b) => b.text).join("");
    results.push({ role: "user", content: text });
  }

  if (toolResultBlocks.length > 0) {
    const toolContent: ToolResultContent[] = toolResultBlocks.map((tr) => ({
      type: "tool-result" as const,
      toolCallId: tr.tool_use_id,
      toolName: toolUseNames.get(tr.tool_use_id) ?? "unknown",
      output: { type: "text" as const, value: tr.content },
    }));
    // AI SDK v6 tool results use role "tool"
    results.push({ role: "tool", content: toolContent } as unknown as ModelMessage);
  }

  return results;
}

function assistantToModel(
  msg: Extract<ProviderMessage, { role: "assistant" }>,
  toolUseNames: Map<string, string>
): ModelMessage {
  const textBlocks = msg.content.filter((c) => c.type === "text") as Array<{
    type: "text";
    text: string;
  }>;
  const toolUseBlocks = msg.content.filter((c) => c.type === "tool_use") as Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
  }>;

  // Track tool_use id → name so tool_results can carry the required toolName + be validated.
  for (const tu of toolUseBlocks) {
    toolUseNames.set(tu.id, tu.name);
  }

  if (toolUseBlocks.length === 0) {
    // Text-only assistant message
    const text = textBlocks.map((b) => b.text).join("");
    return { role: "assistant", content: text };
  }

  // Mixed or tool-only: build content array
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];

  for (const tb of textBlocks) {
    content.push({ type: "text", text: tb.text });
  }

  for (const tu of toolUseBlocks) {
    content.push({
      type: "tool-call",
      toolCallId: tu.id,
      toolName: tu.name,
      input: tu.input,
    });
  }

  return { role: "assistant", content } as unknown as ModelMessage;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts our ProviderMessage history to an array of ModelMessage for
 * the Vercel AI SDK v6 streamText() call.
 */
export function providerMessagesToVercel(
  messages: readonly ProviderMessage[]
): ModelMessage[] {
  const result: ModelMessage[] = [];
  // Track tool_use id → name from assistant turns so tool_results carry the required toolName + validate.
  const toolUseNames = new Map<string, string>();

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        result.push(systemToModel(msg));
        break;
      case "user":
        result.push(...userToModel(msg, toolUseNames));
        break;
      case "assistant":
        result.push(assistantToModel(msg, toolUseNames));
        break;
      default: {
        // Exhaustive check
        const _: never = msg;
        void _;
      }
    }
  }

  return result;
}
