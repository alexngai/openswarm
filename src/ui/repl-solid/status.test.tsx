/**
 * status.test.tsx — bun test for the Solid Status component.
 *
 * The Solid JSX transform is registered via bunfig.toml preload — no import
 * needed here. Run with: bun test src/ui/repl-solid/status.test.tsx
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { Status } from "./status.js";
import type { ReplState } from "../repl/state.js";

function makeState(overrides: Partial<ReplState>): ReplState {
  return {
    name: "idle",
    transcript: [],
    input: { value: "", cursor: 0, killBuffer: "" },
    history: [],
    historyIndex: -1,
    historyDraft: "",
    permissionMode: "workspace-write",
    sessionId: "abc12345",
    pendingPermission: undefined,
    streamingEntryId: undefined,
    ...overrides,
  };
}

describe("Status component", () => {
  it("idle state — renders state name in frame", async () => {
    const state = makeState({ name: "idle" });
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Status state={state} model="claude-opus-4-5" getTokens={() => 0} />
      ),
      { width: 80, height: 3 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("idle");
    expect(frame).toContain("claude-opus-4-5");
  });

  it("streaming state — renders state name in frame", async () => {
    const state = makeState({ name: "streaming" });
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Status state={state} model="claude-sonnet-4-6" getTokens={() => 42} />
      ),
      { width: 80, height: 3 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("streaming");
  });

  it("awaiting-permission state — renders permission alert text", async () => {
    const state = makeState({
      name: "awaiting-permission",
      pendingPermission: {
        toolName: "bash",
        toolUseId: "tu-001",
        input: { command: "rm -rf /" },
      },
    });
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Status
          state={state}
          model="claude-opus-4-5"
          getTokens={() => 100}
        />
      ),
      { width: 80, height: 5 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("awaiting-permission");
    expect(frame).toContain("permission: bash");
    expect(frame).toContain("/approve or /deny");
  });
});
