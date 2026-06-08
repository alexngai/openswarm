/**
 * Wire types for the ChatGPT "codex" backend Responses API
 * (https://chatgpt.com/backend-api/codex/responses).
 *
 * These mirror the subset of the OpenAI Responses API that the codex backend
 * accepts, as validated by the 2026-06 live spike (docs/42 §6). Only fields we
 * actually send/read are modeled — this is deliberately not the full API.
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Tool descriptor in Responses "flat function" form (not nested under `function`). */
export interface CodexTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown; // JSON Schema
  readonly strict: boolean;
}

export type CodexToolChoice =
  | "auto"
  | "required"
  | "none"
  | { readonly type: "function"; readonly name: string };

/** Input items replayed into `input[]`. */
export type CodexInputItem =
  | {
      readonly type: "message";
      readonly role: "user" | "assistant";
      readonly content: readonly CodexContentPart[];
    }
  | {
      readonly type: "function_call";
      /** Responses item id (must start with `fc_`); required on replay. */
      readonly id: string;
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string; // JSON-encoded
    }
  | {
      readonly type: "function_call_output";
      readonly call_id: string;
      readonly output: string;
    }
  // A replayed reasoning item (carries encrypted_content). Shape is the codex
  // reasoning item minus its id; kept permissive since it round-trips opaquely.
  | ({ readonly type: "reasoning" } & Record<string, unknown>);

export type CodexContentPart =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "output_text"; readonly text: string; readonly annotations: readonly never[] };

export interface CodexReasoningConfig {
  readonly effort: "minimal" | "low" | "medium" | "high";
  readonly summary: "auto" | "concise" | "detailed" | null;
}

export interface CodexRequestBody {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly CodexInputItem[];
  readonly tools: readonly CodexTool[];
  readonly tool_choice: CodexToolChoice;
  readonly parallel_tool_calls: boolean;
  /** MANDATORY false — the backend rejects `store:true` (docs/42 §5). */
  readonly store: false;
  readonly stream: true;
  readonly include: readonly string[];
  readonly reasoning?: CodexReasoningConfig;
  /** Stable per-session key → ~96% prefix caching on repeat (docs/42 §6.2). */
  readonly prompt_cache_key?: string;
  readonly max_output_tokens?: number;
}

// ---------------------------------------------------------------------------
// Streaming events (standard OpenAI Responses SSE schema — docs/42 §6.3)
// ---------------------------------------------------------------------------

/** A parsed SSE `data:` payload. Only the discriminant `type` is guaranteed. */
export interface CodexSseEvent {
  readonly type: string;
  readonly [k: string]: unknown;
}

/** Usage block from `response.completed`. */
export interface CodexUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  readonly total_tokens?: number;
}
