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
