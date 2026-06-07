/**
 * status.test.tsx — bun test for the Footer component (was Status).
 *
 * The Solid JSX transform is registered via bunfig.toml preload — no import
 * needed here. Run with: bun test src/ui/repl-solid/status.test.tsx
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { Footer } from "./footer.js";
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
    dropdownIndex: 0,
    toolCalls: {},
    globalExpand: false,
    messageQueue: [],
    agents: {},
    tasks: {},
    activeView: "transcript" as const,
    planMode: false,
    mentionedFiles: [],
    ...overrides,
  };
}

describe("Footer component", () => {
  it("idle state — renders state name and model", async () => {
    const state = makeState({ name: "idle" });
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Footer state={state} model="claude-opus-4-5" getTokens={() => 0} />
      ),
      { width: 100, height: 5 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("idle");
    expect(frame).toContain("claude-opus-4-5");
  });

  it("shows context percentage", async () => {
    const state = makeState({ name: "idle" });
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Footer
          state={state}
          model="claude-sonnet-4-6"
          getTokens={() => 50_000}
          contextWindow={200_000}
        />
      ),
      { width: 100, height: 5 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("context: 25%");
  });

  it("shows cost estimate", async () => {
    const state = makeState({ name: "streaming" });
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Footer
          state={state}
          model="claude-sonnet-4-6"
          getTokens={() => 100_000}
          contextWindow={200_000}
        />
      ),
      { width: 100, height: 5 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("cost: $");
    expect(frame).toContain("streaming");
  });

  it("shows permission mode", async () => {
    const state = makeState({ permissionMode: "read-only" });
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Footer state={state} model="test" getTokens={() => 0} />
      ),
      { width: 100, height: 5 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("read-only");
  });
});
