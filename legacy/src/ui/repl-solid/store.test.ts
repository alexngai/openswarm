import { describe, it, expect } from "vitest";
import { createReplStore } from "./store.js";

describe("createReplStore — Solid binding over reduce", () => {
  it("initial state matches createInitialState defaults", () => {
    const { state } = createReplStore();
    expect(state.name).toBe("idle");
    expect(state.transcript).toHaveLength(0);
    expect(state.input.value).toBe("");
    expect(state.permissionMode).toBe("workspace-write");
  });

  it("honors InitialStateOptions", () => {
    const { state } = createReplStore({
      permissionMode: "read-only",
      sessionId: "abc",
    });
    expect(state.permissionMode).toBe("read-only");
    expect(state.sessionId).toBe("abc");
  });

  it("dispatch(submit) transitions idle → streaming", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "hi" });
    expect(state.name).toBe("streaming");
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]!.kind).toBe("user");
    expect(state.transcript[0]!.text).toBe("hi");
  });

  it("dispatch(stream-delta) accumulates into assistant entry", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "hi" });
    dispatch({ type: "stream-delta", text: "hello" });
    dispatch({ type: "stream-delta", text: " world" });
    const assistant = state.transcript.find((t) => t.kind === "assistant");
    expect(assistant?.text).toBe("hello world");
  });

  it("dispatch(stream-end) transitions streaming → idle", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "hi" });
    dispatch({ type: "stream-delta", text: "ok" });
    dispatch({ type: "stream-end" });
    expect(state.name).toBe("idle");
    expect(state.streamingEntryId).toBeUndefined();
  });

  it("permission-request transitions streaming → awaiting-permission", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "run" });
    dispatch({
      type: "permission-request",
      request: {
        toolName: "bash",
        input: {},
        currentMode: "read-only",
        requiredPermission: "write",
      },
    });
    expect(state.name).toBe("awaiting-permission");
    expect(state.pendingPermission?.toolName).toBe("bash");
  });

  it("compact-begin/end transitions (streaming → compact → streaming)", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "hi" });
    dispatch({ type: "compact-begin" });
    expect(state.name).toBe("compact");
    dispatch({ type: "compact-end" });
    expect(state.name).toBe("streaming");
  });

  // -------------------------------------------------------------------
  // Phase 1a — tool call lifecycle
  // -------------------------------------------------------------------

  it("tool-start creates toolCalls entry and transcript entry with toolCallId", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-start", id: "tc-1", name: "bash" });
    expect(state.toolCalls["tc-1"]).toBeDefined();
    expect(state.toolCalls["tc-1"]!.name).toBe("bash");
    expect(state.toolCalls["tc-1"]!.pending).toBe(true);
    const toolEntry = state.transcript.find((t) => t.toolCallId === "tc-1");
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.kind).toBe("tool");
  });

  it("tool-args-delta accumulates streaming args", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-start", id: "tc-1", name: "read_file" });
    dispatch({ type: "tool-args-delta", id: "tc-1", jsonDelta: '{"file_' });
    dispatch({ type: "tool-args-delta", id: "tc-1", jsonDelta: 'path": "src/main.ts"}' });
    expect(state.toolCalls["tc-1"]!.streamingArgs).toBe('{"file_path": "src/main.ts"}');
  });

  it("tool-args-delta for unknown id is no-op", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-args-delta", id: "unknown", jsonDelta: "{}" });
    expect(state.toolCalls["unknown"]).toBeUndefined();
  });

  it("tool-result finalizes tool call with content and parsed args", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-start", id: "tc-1", name: "read_file" });
    dispatch({ type: "tool-args-delta", id: "tc-1", jsonDelta: '{"file_path": "src/index.ts"}' });
    dispatch({ type: "tool-result", id: "tc-1", content: "const x = 1;", isError: false });
    const tc = state.toolCalls["tc-1"]!;
    expect(tc.pending).toBe(false);
    expect(tc.result).toBe("const x = 1;");
    expect(tc.isError).toBe(false);
    expect((tc.args as Record<string, unknown>)?.file_path).toBe("src/index.ts");
  });

  it("tool-result for unknown id is no-op", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-result", id: "unknown", content: "x", isError: false });
    expect(state.toolCalls["unknown"]).toBeUndefined();
  });

  it("tool-result marks isError correctly", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-start", id: "tc-1", name: "bash" });
    dispatch({ type: "tool-result", id: "tc-1", content: "command not found", isError: true });
    expect(state.toolCalls["tc-1"]!.isError).toBe(true);
  });

  it("toggle-expand flips globalExpand", () => {
    const { state, dispatch } = createReplStore();
    expect(state.globalExpand).toBe(false);
    dispatch({ type: "toggle-expand" });
    expect(state.globalExpand).toBe(true);
    dispatch({ type: "toggle-expand" });
    expect(state.globalExpand).toBe(false);
  });

  it("multiple tool calls in same turn are tracked independently", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-start", id: "tc-1", name: "read_file" });
    dispatch({ type: "tool-start", id: "tc-2", name: "read_file" });
    dispatch({ type: "tool-result", id: "tc-1", content: "file1", isError: false });
    expect(state.toolCalls["tc-1"]!.pending).toBe(false);
    expect(state.toolCalls["tc-2"]!.pending).toBe(true);
    dispatch({ type: "tool-result", id: "tc-2", content: "file2", isError: false });
    expect(state.toolCalls["tc-2"]!.pending).toBe(false);
  });

  it("tool-result handles malformed streaming args gracefully", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-start", id: "tc-1", name: "bash" });
    dispatch({ type: "tool-args-delta", id: "tc-1", jsonDelta: '{"broken' });
    dispatch({ type: "tool-result", id: "tc-1", content: "ok", isError: false });
    expect(state.toolCalls["tc-1"]!.args).toBeUndefined();
    expect(state.toolCalls["tc-1"]!.result).toBe("ok");
  });

  it("legacy tool-entry still works for backward compat", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "tool-entry", id: "legacy-1", name: "old_tool", summary: "did stuff" });
    const entry = state.transcript.find((t) => t.id === "legacy-1");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("tool");
    expect(entry!.toolCallId).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Phase 3 — message queue
  // -------------------------------------------------------------------

  it("queue-message appends to messageQueue during streaming", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    expect(state.name).toBe("streaming");
    dispatch({ type: "queue-message", text: "follow up 1" });
    dispatch({ type: "queue-message", text: "follow up 2" });
    expect(state.messageQueue).toEqual(["follow up 1", "follow up 2"]);
  });

  it("queue-message is no-op when not streaming", () => {
    const { state, dispatch } = createReplStore();
    expect(state.name).toBe("idle");
    dispatch({ type: "queue-message", text: "should not queue" });
    expect(state.messageQueue).toHaveLength(0);
  });

  it("queue-message clears input buffer", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "input-changed", value: "next question", cursor: 13 });
    dispatch({ type: "queue-message", text: "next question" });
    expect(state.input.value).toBe("");
    expect(state.input.cursor).toBe(0);
  });

  it("queue-message rejects empty text", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "queue-message", text: "" });
    expect(state.messageQueue).toHaveLength(0);
  });

  it("dequeue-message removes first from messageQueue", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "queue-message", text: "a" });
    dispatch({ type: "queue-message", text: "b" });
    dispatch({ type: "stream-end" });
    // After stream-end state is idle; dequeue manually for unit test.
    dispatch({ type: "dequeue-message" });
    expect(state.messageQueue).toEqual(["b"]);
  });

  it("dequeue-message on empty queue is no-op", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "dequeue-message" });
    expect(state.messageQueue).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Steer event
  // -------------------------------------------------------------------

  it("steer during streaming adds (steered) user entry and clears input", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "input-changed", value: "follow up", cursor: 9 });
    dispatch({ type: "steer", text: "follow up" });
    const steered = state.transcript.find((t) => t.text.includes("(steered)"));
    expect(steered).toBeDefined();
    expect(steered!.text).toBe("(steered) follow up");
    expect(steered!.kind).toBe("user");
    expect(state.input.value).toBe("");
  });

  it("steer is no-op when not streaming", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "steer", text: "hello" });
    expect(state.transcript).toHaveLength(0);
  });

  it("steer rejects empty text", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    const lenBefore = state.transcript.length;
    dispatch({ type: "steer", text: "" });
    expect(state.transcript.length).toBe(lenBefore);
  });

  // -------------------------------------------------------------------
  // Clear resets toolCalls
  // -------------------------------------------------------------------

  it("clear resets both transcript and toolCalls", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "go" });
    dispatch({ type: "tool-start", id: "tc-1", name: "bash" });
    dispatch({ type: "tool-result", id: "tc-1", content: "ok", isError: false });
    dispatch({ type: "stream-end" });
    expect(state.toolCalls["tc-1"]).toBeDefined();
    dispatch({ type: "clear" });
    expect(state.transcript).toHaveLength(0);
    expect(state.toolCalls).toEqual({});
  });

  // -------------------------------------------------------------------
  // Phase 5 — multi-agent state
  // -------------------------------------------------------------------

  it("agent-spawned creates agent record", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "agent-spawned", id: "a1", name: "researcher", role: "search" });
    expect(state.agents["a1"]).toBeDefined();
    expect(state.agents["a1"]!.name).toBe("researcher");
    expect(state.agents["a1"]!.phase).toBe("spawning");
  });

  it("agent-spawned with parentId tracks hierarchy", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "agent-spawned", id: "a1", name: "orchestrator", role: "plan" });
    dispatch({ type: "agent-spawned", id: "a2", name: "worker", role: "execute", parentId: "a1" });
    expect(state.agents["a2"]!.parentId).toBe("a1");
  });

  it("agent-status updates phase and metrics", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "agent-spawned", id: "a1", name: "worker", role: "code" });
    dispatch({ type: "agent-status", id: "a1", phase: "running", toolCount: 3, tokenUsage: 5000 });
    expect(state.agents["a1"]!.phase).toBe("running");
    expect(state.agents["a1"]!.toolCount).toBe(3);
    expect(state.agents["a1"]!.tokenUsage).toBe(5000);
  });

  it("agent-status for unknown agent is no-op", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "agent-status", id: "unknown", phase: "done" });
    expect(state.agents["unknown"]).toBeUndefined();
  });

  it("task-update creates task record", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "task-update", id: "t1", title: "Fix bug", status: "pending", assignee: "worker-1" });
    expect(state.tasks["t1"]).toBeDefined();
    expect(state.tasks["t1"]!.title).toBe("Fix bug");
    expect(state.tasks["t1"]!.status).toBe("pending");
    expect(state.tasks["t1"]!.assignee).toBe("worker-1");
  });

  it("task-update updates existing task status", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "task-update", id: "t1", title: "Fix bug", status: "pending" });
    dispatch({ type: "task-update", id: "t1", title: "Fix bug", status: "done" });
    expect(state.tasks["t1"]!.status).toBe("done");
  });

  it("set-view changes activeView", () => {
    const { state, dispatch } = createReplStore();
    expect(state.activeView).toBe("transcript");
    dispatch({ type: "set-view", view: "agents" });
    expect(state.activeView).toBe("agents");
    dispatch({ type: "set-view", view: "tasks" });
    expect(state.activeView).toBe("tasks");
    dispatch({ type: "set-view", view: "transcript" });
    expect(state.activeView).toBe("transcript");
  });

  // -------------------------------------------------------------------
  // Phase 6 — input enhancements
  // -------------------------------------------------------------------

  it("toggle-plan-mode flips planMode", () => {
    const { state, dispatch } = createReplStore();
    expect(state.planMode).toBe(false);
    dispatch({ type: "toggle-plan-mode" });
    expect(state.planMode).toBe(true);
    dispatch({ type: "toggle-plan-mode" });
    expect(state.planMode).toBe(false);
  });

  it("add-mentioned-file tracks file and deduplicates", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "add-mentioned-file", filePath: "src/main.ts" });
    dispatch({ type: "add-mentioned-file", filePath: "src/index.ts" });
    dispatch({ type: "add-mentioned-file", filePath: "src/main.ts" }); // duplicate
    expect(state.mentionedFiles).toEqual(["src/main.ts", "src/index.ts"]);
  });

  it("clear-mentioned-files empties the list", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "add-mentioned-file", filePath: "a.ts" });
    dispatch({ type: "add-mentioned-file", filePath: "b.ts" });
    dispatch({ type: "clear-mentioned-files" });
    expect(state.mentionedFiles).toHaveLength(0);
  });

  it("submit clears mentioned files", () => {
    const { state, dispatch } = createReplStore();
    dispatch({ type: "add-mentioned-file", filePath: "a.ts" });
    dispatch({ type: "submit", text: "use the files" });
    expect(state.mentionedFiles).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Original tests
  // -------------------------------------------------------------------

  it("reconcile preserves fine-grained reactivity: transcript array updates", () => {
    // Reactivity is implicitly proven: reads of `state.name` and
    // `state.transcript` after dispatch return fresh values. That requires
    // setState(reconcile(next)) to have mutated the Solid proxy; a naive
    // identity replace would not expose updates through the proxy.
    const { state, dispatch } = createReplStore();
    dispatch({ type: "submit", text: "one" });
    const lenAfterOne = state.transcript.length;
    dispatch({ type: "stream-delta", text: "hi" });
    dispatch({ type: "stream-end" });
    dispatch({ type: "submit", text: "two" });
    expect(state.transcript.length).toBeGreaterThan(lenAfterOne);
  });
});
