/**
 * app-keys.test.tsx — end-to-end validation of global key chords (doc 49).
 *
 * These drive the composed <App/> with the input focused (the default) and
 * assert the full Input → onKey → handleKey → reducer → render path for the
 * chords added by the TUI-parity work: Ctrl+R (dump transcript), Ctrl+G
 * (external editor), and Ctrl+A (view switch). This is the closest we can get
 * to "actual interactive use" of these chords without a real PTY.
 *
 * Bun test (not vitest) because <App/> pulls @opentui/core's bun:ffi.
 */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "./app.js";
import type { NormalizedEvent } from "../../core/types.js";

function emptyEvents(): AsyncIterable<NormalizedEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<NormalizedEvent> {
      // Never yields; keeps the pump alive without emitting engine events.
      await new Promise<void>(() => {});
    },
  };
}

async function flush(ms = 40): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

describe("App — global key chords (interactive)", () => {
  it("Ctrl+R dumps the transcript and adds a 'saved to' system entry", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await testRender(
      () => (
        <App events={emptyEvents()} model="test-model" permissionMode="workspace-write" onSubmit={() => {}} />
      ),
      { width: 100, height: 20 },
    );
    await renderOnce();

    mockInput.pressKey("r", { ctrl: true });
    await flush();
    await renderOnce();

    expect(captureCharFrame()).toContain("saved to");
  });

  it("Ctrl+G with no $VISUAL/$EDITOR surfaces an 'external editor' error entry", async () => {
    const savedVisual = process.env.VISUAL;
    const savedEditor = process.env.EDITOR;
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    try {
      const { captureCharFrame, mockInput, renderOnce } = await testRender(
        () => (
          <App events={emptyEvents()} model="test-model" permissionMode="workspace-write" onSubmit={() => {}} />
        ),
        { width: 100, height: 20 },
      );
      await renderOnce();

      mockInput.pressKey("g", { ctrl: true });
      await flush();
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("external editor");
    } finally {
      if (savedVisual !== undefined) process.env.VISUAL = savedVisual;
      if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
    }
  });

  it("Ctrl+A switches to the agents view (chord reaches handleKey while input is focused)", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await testRender(
      () => (
        <App events={emptyEvents()} model="test-model" permissionMode="workspace-write" onSubmit={() => {}} />
      ),
      { width: 100, height: 20 },
    );
    await renderOnce();

    mockInput.pressKey("a", { ctrl: true });
    await flush();
    await renderOnce();

    expect(captureCharFrame()).toContain("Agents");
  });
});
