/**
 * Translate codex Responses SSE events into swarm-harness ProviderEvents.
 *
 * Stateful because tool-call arguments stream as deltas keyed by the Responses
 * item id (`fc_*`), while downstream correlation uses `call_id` (the id a
 * tool_result references). We map item_id → {call_id, name} on item.added and
 * resolve deltas through it.
 *
 * Reasoning items are surfaced as `reasoning-delta` for display only; their
 * encrypted payload is dropped in Phase 1 (replay is optional — docs/42 §6.1).
 */

import type { ProviderEvent } from "../index.js";
import type { StopReason, Usage } from "../../core/types.js";
import type { CodexSseEvent, CodexUsage } from "./types.js";

interface PendingCall {
  readonly callId: string;
  readonly name: string;
  args: string;
}

export class CodexEventTranslator {
  /** item_id → in-flight function call. */
  private readonly calls = new Map<string, PendingCall>();
  private sawToolCall = false;
  private emittedDone = new Set<string>();

  translate(ev: CodexSseEvent): ProviderEvent[] {
    switch (ev.type) {
      case "response.output_item.added":
        return this.onItemAdded(ev);
      case "response.function_call_arguments.delta":
        return this.onArgsDelta(ev);
      case "response.function_call_arguments.done":
        return this.onArgsDone(ev);
      case "response.output_item.done":
        return this.onItemDone(ev);
      case "response.output_text.delta": {
        const d = strField(ev, "delta");
        return d ? [{ type: "text-delta", text: d }] : [];
      }
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const d = strField(ev, "delta");
        return d ? [{ type: "reasoning-delta", text: d }] : [];
      }
      case "response.completed":
        return [this.onCompleted(ev)];
      case "response.failed":
      case "error":
        return [this.onFailed(ev)];
      default:
        return [];
    }
  }

  private onItemAdded(ev: CodexSseEvent): ProviderEvent[] {
    const item = ev.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "function_call") return [];
    const itemId = String(item.id ?? "");
    const callId = String(item.call_id ?? itemId);
    const name = String(item.name ?? "");
    this.calls.set(itemId, { callId, name, args: "" });
    return [{ type: "tool-input-start", id: callId, name }];
  }

  private onArgsDelta(ev: CodexSseEvent): ProviderEvent[] {
    const itemId = strField(ev, "item_id");
    const delta = strField(ev, "delta");
    if (!itemId || !delta) return [];
    const call = this.calls.get(itemId);
    if (!call) return [];
    call.args += delta;
    return [{ type: "tool-input-delta", id: call.callId, delta }];
  }

  private onArgsDone(ev: CodexSseEvent): ProviderEvent[] {
    const itemId = strField(ev, "item_id");
    if (!itemId) return [];
    const call = this.calls.get(itemId);
    if (!call || this.emittedDone.has(itemId)) return [];
    this.emittedDone.add(itemId);
    this.sawToolCall = true;
    const raw = strField(ev, "arguments") || call.args || "{}";
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
    return [{ type: "tool-call", id: call.callId, name: call.name, input }];
  }

  /**
   * Fallback emit for a function_call whose `function_call_arguments.done`
   * frame never arrived (e.g. dropped/truncated). `output_item.done` carries
   * the finalized item, so synthesize the tool-call from it. The `emittedDone`
   * guard prevents a double-emit when both frames are present.
   */
  private onItemDone(ev: CodexSseEvent): ProviderEvent[] {
    const item = ev.item as Record<string, unknown> | undefined;
    // Capture the completed reasoning item (incl. encrypted_content) as an
    // opaque signature for replay-based reasoning continuity.
    if (item?.type === "reasoning") {
      return [{ type: "reasoning", signature: JSON.stringify(item) }];
    }
    if (!item || item.type !== "function_call") return [];
    const itemId = String(item.id ?? "");
    if (this.emittedDone.has(itemId)) return [];
    const call = this.calls.get(itemId);
    const callId = call?.callId ?? String(item.call_id ?? itemId);
    const name = call?.name ?? String(item.name ?? "");
    this.emittedDone.add(itemId);
    this.sawToolCall = true;
    const raw = (typeof item.arguments === "string" && item.arguments) || call?.args || "{}";
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
    return [{ type: "tool-call", id: callId, name, input }];
  }

  private onCompleted(ev: CodexSseEvent): ProviderEvent {
    const response = (ev.response as Record<string, unknown> | undefined) ?? {};
    const usage = mapUsage(response.usage as CodexUsage | undefined);
    return { type: "finish", stopReason: this.resolveStop(response), usage };
  }

  private resolveStop(response: Record<string, unknown>): StopReason {
    if (this.sawToolCall) return "tool_use";
    const status = response.status;
    const incomplete = response.incomplete_details as
      | { reason?: string }
      | undefined;
    if (status === "incomplete" && incomplete?.reason === "max_output_tokens") {
      return "max_tokens";
    }
    return "end_turn";
  }

  private onFailed(ev: CodexSseEvent): ProviderEvent {
    const response = ev.response as Record<string, unknown> | undefined;
    const err = (response?.error ?? ev.error) as
      | { code?: string; message?: string }
      | undefined;
    // Map to a code the engine's retry classifier understands (provider_error
    // is not in its union and would degrade to "unknown"). Transient failures
    // stay retryable for parity with classifyCodexHttpError.
    const code = (err?.code ?? "").toLowerCase();
    const retryable = /server_error|rate_limit|overloaded|unavailable|timeout/.test(code);
    return {
      type: "error",
      code: "provider_unavailable",
      message: err?.message ?? "codex response failed",
      retryable,
    };
  }
}

function strField(ev: CodexSseEvent, key: string): string | undefined {
  const v = ev[key];
  return typeof v === "string" ? v : undefined;
}

function mapUsage(u: CodexUsage | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    ...(u?.input_tokens_details?.cached_tokens !== undefined
      ? { cacheReadInputTokens: u.input_tokens_details.cached_tokens }
      : {}),
  };
}
