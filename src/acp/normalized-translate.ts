/**
 * Shared NormalizedEvent -> ACP session/update emission, used by both the
 * single-agent translator (Stage A) and the team lane translator (Stage B).
 *
 * The team path forwards each member's engine events on the lane bus with the
 * payload being the raw NormalizedEvent (src/cli/worker-entry.ts), so the same
 * mapping serves both. Per-event options let the team path attribute work to a
 * member: `titlePrefix` ("[role] "), `idPrefix` (agentId, to keep tool-call ids
 * unique across members), and `suppressText` (collapse: only the lead narrates).
 */

import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type {
  NormalizedEvent,
  StopReason as EngineStopReason,
} from "../core/types.js";
import {
  toolKind,
  toolTitle,
  toolLocations,
  diffContent,
  isEditTool,
} from "./tool-kind.js";

export interface OpenTool {
  readonly name: string;
  readonly jsonParts: string[];
}

export interface EmitOptions {
  send(update: SessionUpdate): Promise<void>;
  /** Shared across calls; keyed by the (prefixed) tool-call id. */
  open: Map<string, OpenTool>;
  /** message_stop / error resolve the turn stop reason (single-agent only). */
  setStop?: (reason: StopReason) => void;
  /** Prefix for tool-call ids — keeps ids unique across team members. */
  idPrefix?: string;
  /** Title prefix, e.g. "[architect] ". */
  titlePrefix?: string;
  /** Suppress agent_message_chunk (collapsed non-lead members). */
  suppressText?: boolean;
  /** Map todo_write to a plan update (single-agent). Team plan comes from the roster. */
  planFromTodos?: boolean;
}

export function parseJson(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function mapStop(reason: EngineStopReason): StopReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "error":
      return "refusal";
    default:
      return "end_turn";
  }
}

function mapTodoStatus(s: unknown): "pending" | "in_progress" | "completed" {
  return s === "in_progress" || s === "completed" ? s : "pending";
}

export async function emitNormalizedEvent(
  ne: NormalizedEvent,
  opts: EmitOptions,
): Promise<void> {
  const { send, open } = opts;
  const idPrefix = opts.idPrefix ?? "";
  const titlePrefix = opts.titlePrefix ?? "";
  const planFromTodos = opts.planFromTodos ?? true;

  switch (ne.type) {
    case "text_delta":
      if (opts.suppressText) return;
      await send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: ne.text },
      });
      return;

    case "tool_use_start": {
      const key = idPrefix + ne.id;
      open.set(key, { name: ne.name, jsonParts: [] });
      if (ne.name === "todo_write" && planFromTodos) return; // -> plan at end
      await send({
        sessionUpdate: "tool_call",
        toolCallId: key,
        title: titlePrefix + toolTitle(ne.name, undefined),
        kind: toolKind(ne.name),
        status: "pending",
      });
      return;
    }

    case "tool_use_input":
      open.get(idPrefix + ne.id)?.jsonParts.push(ne.jsonDelta);
      return;

    case "tool_use_end": {
      const key = idPrefix + ne.id;
      const t = open.get(key);
      if (t === undefined) return;
      const input = parseJson(t.jsonParts.join(""));
      if (t.name === "todo_write" && planFromTodos) {
        await emitTodoPlan(send, input);
        return;
      }
      const locations = toolLocations(t.name, input);
      const content = isEditTool(t.name) ? diffContent(t.name, input) : undefined;
      await send({
        sessionUpdate: "tool_call_update",
        toolCallId: key,
        status: "in_progress",
        title: titlePrefix + toolTitle(t.name, input),
        rawInput: input,
        ...(locations !== undefined ? { locations } : {}),
        ...(content !== undefined ? { content } : {}),
      });
      return;
    }

    case "tool_result":
      await send({
        sessionUpdate: "tool_call_update",
        toolCallId: idPrefix + ne.toolUseId,
        status: ne.isError ? "failed" : "completed",
        content: [
          { type: "content", content: { type: "text", text: ne.content } },
        ],
        rawOutput: ne.content,
      });
      return;

    case "message_stop":
      opts.setStop?.(mapStop(ne.stopReason));
      return;

    case "error":
      opts.setStop?.("refusal");
      return;

    default:
      return;
  }
}

async function emitTodoPlan(
  send: (update: SessionUpdate) => Promise<void>,
  input: unknown,
): Promise<void> {
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return;
  const entries = todos.map((t) => {
    const todo = (t ?? {}) as { content?: unknown; status?: unknown };
    return {
      content: String(todo.content ?? ""),
      priority: "medium" as const,
      status: mapTodoStatus(todo.status),
    };
  });
  await send({ sessionUpdate: "plan", entries });
}
