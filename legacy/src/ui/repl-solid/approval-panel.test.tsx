/**
 * approval-panel.test.tsx — approval preview, danger label, expanded diff
 * (doc 49 Phase D2/D5). Uses bun:test (@opentui/core needs bun:ffi).
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { ApprovalPanel } from "./approval-panel.js";
import type { PendingPermission } from "../repl/state.js";

async function frameAfter(
  render: () => Promise<void>,
  capture: () => string,
  ms = 60,
): Promise<string> {
  await render();
  await new Promise<void>((r) => setTimeout(r, ms));
  await render();
  return capture();
}

function pending(overrides: Partial<PendingPermission>): PendingPermission {
  return {
    toolName: "bash",
    input: {},
    currentMode: "workspace-write",
    requiredPermission: "exec",
    ...overrides,
  } as PendingPermission;
}

describe("ApprovalPanel", () => {
  it("shows a destructive warning for rm -rf /", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <ApprovalPanel
          pending={pending({ toolName: "bash", input: { command: "rm -rf /" } })}
        />
      ),
      { width: 80, height: 16 },
    );
    const frame = await frameAfter(renderOnce, captureCharFrame);
    expect(frame).toContain("destructive");
  });

  it("does not show a warning for a safe command", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <ApprovalPanel
          pending={pending({ toolName: "bash", input: { command: "ls -la" } })}
        />
      ),
      { width: 80, height: 16 },
    );
    const frame = await frameAfter(renderOnce, captureCharFrame);
    expect(frame).not.toContain("destructive");
  });

  it("offers ctrl+e full diff for edits and renders diff content when expanded", async () => {
    const p = pending({
      toolName: "edit_file",
      input: { file_path: "foo.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
      requiredPermission: "write",
    });
    const { captureCharFrame, renderOnce } = await testRender(
      () => <ApprovalPanel pending={p} expanded={true} />,
      { width: 80, height: 20 },
    );
    const frame = await frameAfter(renderOnce, captureCharFrame);
    expect(frame).toContain("const x = 2;");
    expect(frame).toContain("collapse");
  });
});
