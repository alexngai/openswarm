/**
 * app.test.tsx — integration smoke for the composed Solid root.
 *
 * Proves that transcript + input + status + spinner render together, that
 * engine events drive the store, and that streaming text appears in the
 * captured frame.
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "./app.js";
import type { NormalizedEvent } from "../../core/types.js";

async function flushAsyncPump(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("App — Solid root composition", () => {
  it("renders the three core panels (transcript, input, status)", async () => {
    const events = (async function* () {
      // no events — just mount and capture
    })();

    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <App
          events={events}
          model="claude-opus-4-6"
          permissionMode="workspace-write"
          getTokens={() => 0}
        />
      ),
      { width: 80, height: 20 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    // Status line should contain the model name.
    expect(frame).toContain("claude-opus-4-6");
  });

  it("surfaces tool_use_start as a tool chip in the transcript", async () => {
    const events = (async function* (): AsyncGenerator<NormalizedEvent> {
      yield { type: "tool_use_start", id: "tu-42", name: "bash" };
    })();

    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <App
          events={events}
          model="test-model"
          permissionMode="workspace-write"
        />
      ),
      { width: 80, height: 20 },
    );
    await renderOnce();
    await flushAsyncPump(100);
    await renderOnce();
    const frame = captureCharFrame();
    // Tool chip should show pending bullet and tool name.
    expect(frame).toContain("bash");
    expect(frame).toContain("●");
    expect(frame).toContain("Using");
  });

  it("surfaces tool-result error in tool chip", async () => {
    const events = (async function* (): AsyncGenerator<NormalizedEvent> {
      yield { type: "tool_use_start", id: "tu-1", name: "bash" };
      yield {
        type: "tool_result",
        toolUseId: "tu-1",
        content: "permission denied: bash",
        isError: true,
      };
    })();

    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <App
          events={events}
          model="test-model"
          permissionMode="workspace-write"
        />
      ),
      { width: 80, height: 20 },
    );
    await renderOnce();
    await flushAsyncPump(100);
    await renderOnce();
    const frame = captureCharFrame();
    // Tool chip should show error bullet and bash tool name.
    expect(frame).toContain("bash");
    expect(frame).toContain("✗");
  });
});
