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

const SWARM_TOOLS = [
  "send_message",
  "check_inbox",
  "task_stop",
  "task_output",
  "ask_user_question",
] as const;

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

describe("filterToolsForFramework", () => {
  it("native → returns tools unchanged", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "native");
    expect(result).toBe(ALL_TOOLS); // same reference — no copy
  });

  it("auto → returns tools unchanged", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "auto");
    expect(result).toBe(ALL_TOOLS);
  });

  it("codex-chatgpt → removes all SwarmHost tools, keeps non-swarm tools", () => {
    const result = filterToolsForFramework(
      [send_message, check_inbox, read_file],
      "codex-chatgpt",
    );
    expect(result.map((t) => t.spec.name)).toEqual(["read_file"]);
  });

  it("claude-agent-sdk → removes all SwarmHost tools, keeps non-swarm tools", () => {
    const result = filterToolsForFramework(
      [send_message, read_file],
      "claude-agent-sdk",
    );
    expect(result.map((t) => t.spec.name)).toEqual(["read_file"]);
  });

  it("codex-chatgpt → removes all five SwarmHost tools from a full list", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "codex-chatgpt");
    const names = result.map((t) => t.spec.name);
    for (const swarmTool of SWARM_TOOLS) {
      expect(names).not.toContain(swarmTool);
    }
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
  });

  it("claude-agent-sdk → removes all five SwarmHost tools from a full list", () => {
    const result = filterToolsForFramework(ALL_TOOLS, "claude-agent-sdk");
    const names = result.map((t) => t.spec.name);
    for (const swarmTool of SWARM_TOOLS) {
      expect(names).not.toContain(swarmTool);
    }
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
  });

  it("codex-chatgpt with empty list → returns empty list", () => {
    const result = filterToolsForFramework([], "codex-chatgpt");
    expect(result).toHaveLength(0);
  });

  it("native with empty list → returns same empty list", () => {
    const result = filterToolsForFramework([], "native");
    expect(result).toHaveLength(0);
  });
});
