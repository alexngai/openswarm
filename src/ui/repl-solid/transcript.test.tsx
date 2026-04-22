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

const entries: readonly TranscriptEntry[] = [
  { id: "u-0", kind: "user", text: "hello from user" },
  { id: "a-1", kind: "assistant", text: "hello from assistant" },
  { id: "t-2", kind: "tool", text: "read file", tool: { name: "read_file", summary: "src/index.ts" } },
  { id: "s-3", kind: "system", text: "session started" },
];

describe("Transcript component", () => {
  it("renders all entry kinds and their text appears in the frame", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Transcript entries={entries} />,
      { width: 80, height: 20 },
    );
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("hello from user");
    expect(frame).toContain("hello from assistant");
    expect(frame).toContain("read_file");
    expect(frame).toContain("session started");
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
