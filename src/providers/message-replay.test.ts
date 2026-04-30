import { describe, expect, it } from "vitest";
import { providerMessagesToVercel } from "./message-replay.js";
import type { ProviderMessage } from "./index.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("providerMessagesToVercel", () => {
  it("returns empty array for empty session", () => {
    expect(providerMessagesToVercel([])).toEqual([]);
  });

  // ---- system ---------------------------------------------------------------

  it("translates system message — single text block", () => {
    const msgs: ProviderMessage[] = [
      { role: "system", content: [{ type: "text", text: "You are helpful." }] },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("concatenates multiple system text blocks", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "system",
        content: [
          { type: "text", text: "Part A. " },
          { type: "text", text: "Part B." },
        ],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result[0]).toEqual({ role: "system", content: "Part A. Part B." });
  });

  // ---- user (text-only) -----------------------------------------------------

  it("translates text-only user message", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hello!" }] },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "Hello!" });
  });

  // ---- user (tool_result) ---------------------------------------------------

  it("translates tool_result-only user message to role=tool", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-1", name: "read_file", input: { path: "/tmp/x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-1", content: "file contents" }],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    // assistant + tool message
    expect(result).toHaveLength(2);
    const toolMsg = result[1] as { role: string; content: unknown[] };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toHaveLength(1);
    expect((toolMsg.content[0] as { toolCallId: string }).toolCallId).toBe("tc-1");
  });

  it("translates mixed user message (text + tool_result) into two messages", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-2", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Also note:" },
          { type: "tool_result", tool_use_id: "tc-2", content: "file1\nfile2" },
        ],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    // assistant + user text + tool
    expect(result).toHaveLength(3);
    expect(result[1]!.role).toBe("user");
    expect(result[2]!.role).toBe("tool");
  });

  // ---- assistant (text-only) ------------------------------------------------

  it("translates text-only assistant message", () => {
    const msgs: ProviderMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "Here is your answer." }] },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "assistant", content: "Here is your answer." });
  });

  // ---- assistant (tool_use) -------------------------------------------------

  it("translates assistant tool_use blocks to content array", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me help." },
          { type: "tool_use", id: "tc-3", name: "write_file", input: { path: "/x", content: "y" } },
        ],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result).toHaveLength(1);
    const msg = result[0] as { role: string; content: unknown[] };
    expect(msg.role).toBe("assistant");
    expect(Array.isArray(msg.content)).toBe(true);
    const content = msg.content as Array<{ type: string }>;
    expect(content.some((c) => c.type === "text")).toBe(true);
    expect(content.some((c) => c.type === "tool-call")).toBe(true);
  });

  it("assistant tool-call content has toolCallId, toolName, input", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc-4", name: "bash", input: { command: "pwd" } },
        ],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    const msg = result[0] as { role: string; content: unknown[] };
    const toolCall = (msg.content as Array<Record<string, unknown>>).find(
      (c) => c["type"] === "tool-call"
    )!;
    expect(toolCall["toolCallId"]).toBe("tc-4");
    expect(toolCall["toolName"]).toBe("bash");
    expect(toolCall["input"]).toEqual({ command: "pwd" });
  });

  // ---- guard ----------------------------------------------------------------

  it("throws when tool_result references unknown tool_use_id", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "nonexistent", content: "result" }],
      },
    ];
    expect(() => providerMessagesToVercel(msgs)).toThrow(/compactor bug/);
  });

  // ---- multi-turn conversation round-trip -----------------------------------

  it("handles a full user → assistant (tool_use) → user (tool_result) round-trip", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "Run ls" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-5", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-5", content: "README.md" }],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    // user + assistant + tool
    expect(result).toHaveLength(3);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
    expect(result[2]!.role).toBe("tool");
  });
});
