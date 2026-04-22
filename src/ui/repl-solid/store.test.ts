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
      request: { toolName: "bash", toolUseId: "tu-1", input: {} },
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
