import { describe, it, expect } from "vitest";
import { extractMessageText } from "./store.js";

describe("extractMessageText", () => {
  it("returns string content directly", () => {
    expect(extractMessageText({ role: "user", content: "hello" })).toBe("hello");
  });

  it("joins text blocks and skips non-text blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "part one " },
        { type: "tool_use", id: "t1", name: "read_file", input: {} },
        { type: "text", text: "part two" },
      ],
    };
    expect(extractMessageText(msg)).toBe("part one part two");
  });

  it("returns empty string for missing/!object/odd content", () => {
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText({})).toBe("");
    expect(extractMessageText({ content: 42 })).toBe("");
    expect(extractMessageText("nope")).toBe("");
  });
});
