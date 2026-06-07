/**
 * Build a codex Responses request body from a swarm-harness ProviderRequest.
 *
 * Encodes the non-negotiable backend quirks validated by the live spike
 * (docs/42 §5/§6):
 *   - `store: false` is mandatory.
 *   - System prompt goes in `instructions`, not a message.
 *   - `prompt_cache_key` = sessionId → prefix caching across turns.
 *   - Tools use the Responses "flat function" shape.
 *
 * Pure + synchronous → fully unit-testable without network.
 */

import type {
  ProviderRequest,
  ProviderMessage,
} from "../index.js";
import type { ToolSpec } from "../../core/types.js";
import type {
  CodexRequestBody,
  CodexInputItem,
  CodexTool,
  CodexToolChoice,
  CodexReasoningConfig,
} from "./types.js";

export interface BuildRequestOptions {
  /** Stable session id → prompt_cache_key. Omit to disable caching affinity. */
  readonly sessionId?: string;
  /** Reasoning config; omit for non-reasoning behavior. Default medium/auto. */
  readonly reasoning?: CodexReasoningConfig;
}

const DEFAULT_REASONING: CodexReasoningConfig = { effort: "medium", summary: "auto" };

function joinSystemPrompt(sp: string | readonly string[] | undefined): string {
  if (sp === undefined) return "";
  return Array.isArray(sp) ? sp.join("") : (sp as string);
}

function toolToCodex(tool: ToolSpec): CodexTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function toolChoiceToCodex(
  choice: ProviderRequest["toolChoice"],
): CodexToolChoice {
  if (choice === undefined) return "auto";
  if (typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

/**
 * Convert one ProviderMessage into zero or more Responses input items,
 * preserving block order within the message.
 *
 * - system messages are folded into `instructions` upstream and skipped here.
 * - assistant tool_use → function_call (call_id = our single id slot, which is
 *   what the matching tool_result references). We do not carry the Responses
 *   `fc_*` item id — Phase 1 omits it; the live smoke test validates that the
 *   backend accepts function_call input without it (docs/42).
 * - user tool_result → function_call_output keyed by tool_use_id.
 */
function messageToInput(msg: ProviderMessage): CodexInputItem[] {
  if (msg.role === "system") return [];

  if (msg.role === "user") {
    const items: CodexInputItem[] = [];
    const textParts: { type: "input_text"; text: string }[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push({ type: "input_text", text: block.text });
      } else {
        // tool_result — flush any buffered text first to preserve order.
        if (textParts.length > 0) {
          items.push({ type: "message", role: "user", content: [...textParts] });
          textParts.length = 0;
        }
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.is_error ? `ERROR: ${block.content}` : block.content,
        });
      }
    }
    if (textParts.length > 0) {
      items.push({ type: "message", role: "user", content: textParts });
    }
    return items;
  }

  // assistant
  const items: CodexInputItem[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      });
    } else {
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  return items;
}

export function buildCodexRequest(
  req: ProviderRequest,
  opts: BuildRequestOptions = {},
): CodexRequestBody {
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    input.push(...messageToInput(msg));
  }

  const body: CodexRequestBody = {
    model: req.model,
    instructions: joinSystemPrompt(req.systemPrompt),
    input,
    tools: (req.tools ?? []).map(toolToCodex),
    tool_choice: toolChoiceToCodex(req.toolChoice),
    parallel_tool_calls: false,
    store: false,
    stream: true,
    // Requested so Phase 2 reasoning replay has the encrypted payload available;
    // harmless in Phase 1 where reasoning items are surfaced for display only.
    include: ["reasoning.encrypted_content"],
    reasoning: opts.reasoning ?? DEFAULT_REASONING,
    ...(opts.sessionId !== undefined ? { prompt_cache_key: opts.sessionId } : {}),
    ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
  };
  return body;
}
