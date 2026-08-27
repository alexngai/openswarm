/**
 * transcript.test.tsx — Bun-native tests for the Solid Transcript component.
 *
 * Uses `bun:test` (not vitest) because vitest's workers use Node, which can't
 * resolve @opentui/core's `bun:ffi` imports. Run via:
 *   bun test src/ui/repl-solid/transcript.test.tsx
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { Transcript } from "./transcript.js";
import type { TranscriptEntry } from "../repl/state.js";

async function flush(ms = 50): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

async function waitForContent(
  captureCharFrame: () => string,
  renderOnce: () => Promise<void>,
  needle: string,
  maxAttempts = 20,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await flush(50);
    await renderOnce();
    const frame = captureCharFrame();
    if (frame.includes(needle)) return frame;
  }
  return captureCharFrame();
}

// Non-assistant entries — work fine under bare-Transcript bun:test capture.
const nonAssistantEntries: readonly TranscriptEntry[] = [
  { id: "u-0", kind: "user", text: "hello from user" },
  { id: "t-2", kind: "tool", text: "read file", tool: { name: "read_file", summary: "src/index.ts" } },
  { id: "s-3", kind: "system", text: "session started" },
];

// Assistant entry — exercises the `<markdown>` primitive. `<markdown>` paints
// its content a tick after mount (deferred stream-init), so a single
// `renderOnce()` + immediate capture races the paint and misses the text. The
// test polls with `waitForContent` (same pattern as the App-composed e2e
// markdown tests) to let the render settle. No App composition required.
const allEntries: readonly TranscriptEntry[] = [
  ...nonAssistantEntries,
  { id: "a-1", kind: "assistant", text: "hello from assistant" },
];

describe("Transcript component", () => {
  it("renders user/tool/system entry kinds in the frame", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Transcript entries={nonAssistantEntries} />,
      { width: 80, height: 20 },
    );
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("hello from user");
    expect(frame).toContain("read_file");
    expect(frame).toContain("session started");
  });

  it("renders assistant <markdown> entry in bare-Transcript frame", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Transcript entries={allEntries} />,
      { width: 80, height: 20 },
    );
    const frame = await waitForContent(
      captureCharFrame,
      renderOnce,
      "hello from assistant",
    );
    expect(frame).toContain("hello from assistant");
  });

  it("renders an empty transcript without errors", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Transcript entries={[]} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    // Should not throw; frame may be empty
    const frame = captureCharFrame();
    expect(typeof frame).toBe("string");
  });
});
