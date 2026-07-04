/**
 * transcript-export.test.ts — plain-text serialization (doc 49 Phase C1).
 */

import { describe, it, expect } from "vitest";
import { serializeTranscript } from "./transcript-export.js";
import type { TranscriptEntry, ToolCallState } from "../repl/state.js";

describe("serializeTranscript", () => {
  it("serializes user / assistant / system entries with prefixes", () => {
    const entries: TranscriptEntry[] = [
      { id: "u", kind: "user", text: "hello" },
      { id: "a", kind: "assistant", text: "hi there" },
      { id: "s", kind: "system", text: "session started" },
    ];
    const out = serializeTranscript(entries);
    expect(out).toContain("> hello");
    expect(out).toContain("hi there");
    expect(out).toContain("· session started");
  });

  it("includes tool header + body from tool call state", () => {
    const entries: TranscriptEntry[] = [
      { id: "t", kind: "tool", text: "", toolCallId: "tc1" },
    ];
    const toolCalls: Record<string, ToolCallState> = {
      tc1: {
        id: "tc1",
        name: "read_file",
        streamingArgs: "",
        args: { file_path: "foo.ts" },
        result: "const x = 1;",
        pending: false,
        isError: false,
      } as ToolCallState,
    };
    const out = serializeTranscript(entries, toolCalls);
    expect(out).toContain("read_file");
    expect(out).toContain("foo.ts");
    expect(out).toContain("const x = 1;");
  });

  it("falls back to entry.tool when no tool call state is present", () => {
    const entries: TranscriptEntry[] = [
      { id: "t", kind: "tool", text: "ok", tool: { name: "grep", summary: "pattern" } },
    ];
    const out = serializeTranscript(entries);
    expect(out).toContain("grep");
    expect(out).toContain("pattern");
  });

  it("ends with a single trailing newline", () => {
    const out = serializeTranscript([{ id: "u", kind: "user", text: "x" }]);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("returns just a newline for an empty transcript", () => {
    expect(serializeTranscript([])).toBe("\n");
  });
});
