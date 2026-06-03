/**
 * Translate the engine's NormalizedEvent stream into ACP session/update
 * notifications. The single emission chokepoint is `send()` — Stage B attaches
 * `_meta.swarm` here (docs/31). See docs/32 §9.
 *
 *   text_delta                         -> agent_message_chunk
 *   tool_use_start/input/end           -> tool_call (+ tool_call_update w/ diff)
 *   todo_write                         -> plan (not a tool_call)
 *   tool_result                        -> tool_call_update (completed | failed)
 *   message_stop                       -> resolved stopReason
 */

import type {
  AgentSideConnection,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { NormalizedEvent, StopReason as EngineStopReason } from "../core/types.js";
import {
  toolKind,
  toolTitle,
  toolLocations,
  diffContent,
  isEditTool,
} from "./tool-kind.js";

export interface AcpTranslator {
  emit(ev: NormalizedEvent): Promise<void>;
  /** Resolved ACP stop reason after the stream ends (default end_turn). */
  stopReason(): StopReason;
}

interface OpenTool {
  readonly name: string;
  readonly jsonParts: string[];
}

function parseJson(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mapStop(reason: EngineStopReason): StopReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "error":
      return "refusal";
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
    default:
      return "end_turn";
  }
}

function mapTodoStatus(s: unknown): "pending" | "in_progress" | "completed" {
  return s === "in_progress" || s === "completed" ? s : "pending";
}

export function makeAcpTranslator(
  conn: Pick<AgentSideConnection, "sessionUpdate">,
  sessionId: string,
): AcpTranslator {
  const open = new Map<string, OpenTool>();
  let stop: StopReason = "end_turn";

  async function send(update: SessionUpdate): Promise<void> {
    await conn.sessionUpdate({ sessionId, update });
  }

  async function emitPlan(input: unknown): Promise<void> {
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

  return {
    async emit(ev: NormalizedEvent): Promise<void> {
      switch (ev.type) {
        case "text_delta":
          await send({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ev.text },
          });
          return;

        case "tool_use_start": {
          open.set(ev.id, { name: ev.name, jsonParts: [] });
          // todo_write surfaces as a plan, not a tool_call.
          if (ev.name === "todo_write") return;
          await send({
            sessionUpdate: "tool_call",
            toolCallId: ev.id,
            title: toolTitle(ev.name, undefined),
            kind: toolKind(ev.name),
            status: "pending",
          });
          return;
        }

        case "tool_use_input":
          open.get(ev.id)?.jsonParts.push(ev.jsonDelta);
          return;

        case "tool_use_end": {
          const t = open.get(ev.id);
          if (t === undefined) return;
          const input = parseJson(t.jsonParts.join(""));
          if (t.name === "todo_write") {
            await emitPlan(input);
            return;
          }
          const locations = toolLocations(t.name, input);
          const content = isEditTool(t.name)
            ? diffContent(t.name, input)
            : undefined;
          await send({
            sessionUpdate: "tool_call_update",
            toolCallId: ev.id,
            status: "in_progress",
            title: toolTitle(t.name, input),
            rawInput: input,
            ...(locations !== undefined ? { locations } : {}),
            ...(content !== undefined ? { content } : {}),
          });
          return;
        }

        case "tool_result":
          await send({
            sessionUpdate: "tool_call_update",
            toolCallId: ev.toolUseId,
            status: ev.isError ? "failed" : "completed",
            content: [
              { type: "content", content: { type: "text", text: ev.content } },
            ],
            rawOutput: ev.content,
          });
          return;

        case "message_stop":
          stop = mapStop(ev.stopReason);
          return;

        case "error":
          stop = "refusal";
          return;

        // compaction / cache_hit / cache_miss / hook_event / info -> dropped
        default:
          return;
      }
    },
    stopReason: () => stop,
  };
}
