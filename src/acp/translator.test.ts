import { describe, it, expect } from "vitest";
import { makeAcpTranslator } from "./translator.js";
import type { NormalizedEvent } from "../core/types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function recorder() {
  const updates: SessionUpdate[] = [];
  const conn = {
    sessionUpdate: async (n: { update: SessionUpdate }) => {
      updates.push(n.update);
    },
  };
  return { conn, updates };
}

describe("makeAcpTranslator", () => {
  it("maps text_delta to an agent_message_chunk", async () => {
    const { conn, updates } = recorder();
    const t = makeAcpTranslator(conn, "s1");
    await t.emit({ type: "text_delta", text: "hello" });
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    ]);
  });

  it("maps a read tool lifecycle to tool_call + tool_call_update", async () => {
    const { conn, updates } = recorder();
    const t = makeAcpTranslator(conn, "s1");
    const seq: NormalizedEvent[] = [
      { type: "tool_use_start", id: "t1", name: "read_file" },
      { type: "tool_use_input", id: "t1", jsonDelta: '{"file_path":"a.ts","offset":4}' },
      { type: "tool_use_end", id: "t1" },
      { type: "tool_result", toolUseId: "t1", content: "file body", isError: false },
    ];
    for (const e of seq) await t.emit(e);

    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "read",
      status: "pending",
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
      locations: [{ path: "a.ts", line: 4 }],
    });
    expect(updates[2]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
  });

  it("surfaces edit_file as a diff and errors as failed", async () => {
    const { conn, updates } = recorder();
    const t = makeAcpTranslator(conn, "s1");
    await t.emit({ type: "tool_use_start", id: "e1", name: "edit_file" });
    await t.emit({
      type: "tool_use_input",
      id: "e1",
      jsonDelta: '{"path":"a.ts","old_string":"x","new_string":"y"}',
    });
    await t.emit({ type: "tool_use_end", id: "e1" });

    const upd = updates.find(
      (u) => u.sessionUpdate === "tool_call_update",
    ) as { content?: unknown };
    expect(upd.content).toEqual([
      { type: "diff", path: "a.ts", oldText: "x", newText: "y" },
    ]);

    await t.emit({ type: "tool_result", toolUseId: "e1", content: "bad", isError: true });
    const last = updates[updates.length - 1] as { status?: string };
    expect(last.status).toBe("failed");
  });

  it("maps todo_write to a plan, not a tool_call", async () => {
    const { conn, updates } = recorder();
    const t = makeAcpTranslator(conn, "s1");
    await t.emit({ type: "tool_use_start", id: "p1", name: "todo_write" });
    await t.emit({
      type: "tool_use_input",
      id: "p1",
      jsonDelta:
        '{"todos":[{"id":"1","content":"do it","status":"in_progress"}]}',
    });
    await t.emit({ type: "tool_use_end", id: "p1" });
    expect(updates).toEqual([
      {
        sessionUpdate: "plan",
        entries: [{ content: "do it", priority: "medium", status: "in_progress" }],
      },
    ]);
  });

  it("resolves stopReason from message_stop, mapping max_tokens through", async () => {
    const { conn } = recorder();
    const t = makeAcpTranslator(conn, "s1");
    expect(t.stopReason()).toBe("end_turn");
    await t.emit({
      type: "message_stop",
      stopReason: "max_tokens",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(t.stopReason()).toBe("max_tokens");
  });
});
