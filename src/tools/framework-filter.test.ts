import { describe, it, expect } from "vitest";
import { filterToolsForFramework } from "./framework-filter.js";
import type { ToolImpl } from "./types.js";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function stubTool(name: string): ToolImpl {
  return {
    spec: {
      name,
      description: `stub ${name}`,
      inputSchema: { type: "object", properties: {} },
      requiredPermission: "read",
      tier: 0,
    },
    execute: async () => ({ status: "ok", output: "" }),
  };
}

const send_message = stubTool("send_message");
const check_inbox = stubTool("check_inbox");
const task_stop = stubTool("task_stop");
const task_output = stubTool("task_output");
const ask_user_question = stubTool("ask_user_question");
const read_file = stubTool("read_file");
const bash = stubTool("bash");

const ALL_TOOLS = [
  send_message,
  check_inbox,
  task_stop,
  task_output,
  ask_user_question,
  read_file,
  bash,
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// As of v0.4 stage 4G the strip was dropped uniformly: filterToolsForFramework
// is a no-op for all framework modes. Track A (docs/26 §Track A) verified
// SwarmHost-routed tools dispatch correctly through the framework's tool
// surface. The function is kept as a no-op for future framework-specific
// filtering needs.

describe("filterToolsForFramework — no-op as of stage 4G", () => {
  it("native → returns tools unchanged", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "native");
    expect(result).toBe(ALL_TOOLS); // same reference — no copy
  });

  it("auto → returns tools unchanged", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "auto");
    expect(result).toBe(ALL_TOOLS);
  });

  it("claude-agent-sdk → returns tools unchanged (was: stripped pre-4G)", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "claude-agent-sdk");
    expect(result).toBe(ALL_TOOLS);
    const names = result.map((t) => t.spec.name);
    // Tier 2 SwarmHost-routed tools are now retained in framework mode.
    expect(names).toContain("send_message");
    expect(names).toContain("check_inbox");
    expect(names).toContain("task_stop");
    expect(names).toContain("task_output");
    expect(names).toContain("ask_user_question");
  });

  it("codex-chatgpt → returns tools unchanged (was: stripped pre-4G)", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "codex-chatgpt");
    expect(result).toBe(ALL_TOOLS);
    const names = result.map((t) => t.spec.name);
    expect(names).toContain("send_message");
    expect(names).toContain("check_inbox");
    expect(names).toContain("task_stop");
    expect(names).toContain("task_output");
    expect(names).toContain("ask_user_question");
  });

  it("empty input → returns empty list", () => {
    const result = filterToolsForFramework([], "claude-agent-sdk");
    expect(result).toHaveLength(0);
  });
});
