import { describe, it, expect } from "vitest";
import { groupTranscriptEntries } from "./group.js";
import type { TranscriptEntry, ToolCallState } from "../../repl/state.js";

function entry(overrides: Partial<TranscriptEntry> & { id: string; kind: TranscriptEntry["kind"] }): TranscriptEntry {
  return { text: "", ...overrides };
}

function tc(id: string, name: string, pending = false): ToolCallState {
  return { id, name, streamingArgs: "", args: undefined, result: undefined, isError: false, pending };
}

describe("groupTranscriptEntries", () => {
  it("groups 3 consecutive same-name tool entries", () => {
    const entries: TranscriptEntry[] = [
      entry({ id: "t1", kind: "tool", toolCallId: "t1" }),
      entry({ id: "t2", kind: "tool", toolCallId: "t2" }),
      entry({ id: "t3", kind: "tool", toolCallId: "t3" }),
    ];
    const toolCalls: Record<string, ToolCallState> = {
      t1: tc("t1", "read_file"),
      t2: tc("t2", "read_file"),
      t3: tc("t3", "read_file"),
    };
    const result = groupTranscriptEntries(entries, toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("group");
    if (result[0]!.type === "group") {
      expect(result[0]!.entryIds).toEqual(["t1", "t2", "t3"]);
      expect(result[0]!.toolName).toBe("read_file");
    }
  });

  it("does not group different tool names", () => {
    const entries: TranscriptEntry[] = [
      entry({ id: "t1", kind: "tool", toolCallId: "t1" }),
      entry({ id: "t2", kind: "tool", toolCallId: "t2" }),
    ];
    const toolCalls: Record<string, ToolCallState> = {
      t1: tc("t1", "read_file"),
      t2: tc("t2", "bash"),
    };
    const result = groupTranscriptEntries(entries, toolCalls);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("single");
    expect(result[1]!.type).toBe("single");
  });

  it("single tool entry stays ungrouped", () => {
    const entries: TranscriptEntry[] = [
      entry({ id: "t1", kind: "tool", toolCallId: "t1" }),
    ];
    const toolCalls: Record<string, ToolCallState> = {
      t1: tc("t1", "bash"),
    };
    const result = groupTranscriptEntries(entries, toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("single");
  });

  it("mixed entries: user → 2 read_file → user → 1 bash", () => {
    const entries: TranscriptEntry[] = [
      entry({ id: "u1", kind: "user", text: "hi" }),
      entry({ id: "t1", kind: "tool", toolCallId: "t1" }),
      entry({ id: "t2", kind: "tool", toolCallId: "t2" }),
      entry({ id: "u2", kind: "user", text: "ok" }),
      entry({ id: "t3", kind: "tool", toolCallId: "t3" }),
    ];
    const toolCalls: Record<string, ToolCallState> = {
      t1: tc("t1", "read_file"),
      t2: tc("t2", "read_file"),
      t3: tc("t3", "bash"),
    };
    const result = groupTranscriptEntries(entries, toolCalls);
    expect(result).toHaveLength(4);
    expect(result[0]!.type).toBe("single"); // user
    expect(result[1]!.type).toBe("group");  // 2 read_file
    expect(result[2]!.type).toBe("single"); // user
    expect(result[3]!.type).toBe("single"); // single bash
  });

  it("non-tool entries pass through unchanged", () => {
    const entries: TranscriptEntry[] = [
      entry({ id: "u1", kind: "user", text: "hello" }),
      entry({ id: "a1", kind: "assistant", text: "world" }),
      entry({ id: "s1", kind: "system", text: "info" }),
    ];
    const result = groupTranscriptEntries(entries, {});
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.type === "single")).toBe(true);
  });

  it("tool entries without toolCallId stay ungrouped", () => {
    const entries: TranscriptEntry[] = [
      entry({ id: "t1", kind: "tool", tool: { name: "bash" } }),
      entry({ id: "t2", kind: "tool", tool: { name: "bash" } }),
    ];
    const result = groupTranscriptEntries(entries, {});
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("single");
    expect(result[1]!.type).toBe("single");
  });

  it("interrupted group: same name tools split by a system entry", () => {
    const entries: TranscriptEntry[] = [
      entry({ id: "t1", kind: "tool", toolCallId: "t1" }),
      entry({ id: "t2", kind: "tool", toolCallId: "t2" }),
      entry({ id: "s1", kind: "system", text: "hook" }),
      entry({ id: "t3", kind: "tool", toolCallId: "t3" }),
    ];
    const toolCalls: Record<string, ToolCallState> = {
      t1: tc("t1", "read_file"),
      t2: tc("t2", "read_file"),
      t3: tc("t3", "read_file"),
    };
    const result = groupTranscriptEntries(entries, toolCalls);
    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe("group");
    if (result[0]!.type === "group") {
      expect(result[0]!.entryIds).toEqual(["t1", "t2"]);
    }
    expect(result[1]!.type).toBe("single"); // system
    expect(result[2]!.type).toBe("single"); // single read_file
  });
});
