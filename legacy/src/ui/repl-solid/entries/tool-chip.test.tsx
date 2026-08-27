/**
 * tool-chip.test.tsx — render tests for code/diff bodies (doc 49 Phase A2/B2).
 *
 * Uses `bun:test` (not vitest) — @opentui/core needs bun:ffi. Run via:
 *   bun test src/ui/repl-solid/entries/tool-chip.test.tsx
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { ToolChip } from "./tool-chip.js";
import type { ToolCallState } from "../../repl/state.js";

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

function toolCall(overrides: Partial<ToolCallState>): ToolCallState {
  return {
    id: "tc-1",
    name: "read_file",
    streamingArgs: "",
    args: {},
    result: undefined,
    pending: false,
    isError: false,
    ...overrides,
  } as ToolCallState;
}

describe("ToolChip code/diff bodies", () => {
  it("renders a read_file body as highlighted code (source visible)", async () => {
    const tc = toolCall({
      name: "read_file",
      args: { file_path: "foo.ts" },
      result: "const x = 1;\nconsole.log(x);",
    });
    const { captureCharFrame, renderOnce } = await testRender(
      () => <ToolChip tc={tc} expanded={true} />,
      { width: 80, height: 12 },
    );
    const frame = await waitForContent(captureCharFrame, renderOnce, "console.log");
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain("console.log(x);");
  });

  it("renders an edit_file body as a diff with +/- content", async () => {
    const tc = toolCall({
      name: "edit_file",
      args: {
        file_path: "foo.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
      result: "ok",
    });
    const { captureCharFrame, renderOnce } = await testRender(
      () => <ToolChip tc={tc} expanded={true} />,
      { width: 80, height: 12 },
    );
    const frame = await waitForContent(captureCharFrame, renderOnce, "const x = 2;");
    // Both old and new content appear in the unified diff.
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain("const x = 2;");
  });

  it("does not render the body when collapsed", async () => {
    const tc = toolCall({
      name: "read_file",
      args: { file_path: "foo.ts" },
      result: "const secret = 42;",
    });
    const { captureCharFrame, renderOnce } = await testRender(
      () => <ToolChip tc={tc} expanded={false} />,
      { width: 80, height: 12 },
    );
    await renderOnce();
    await flush(60);
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain("const secret = 42;");
  });
});
