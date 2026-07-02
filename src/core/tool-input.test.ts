import { describe, it, expect } from "vitest";
import { parseToolInput, ToolInputAccumulator } from "./tool-input.js";

describe("parseToolInput", () => {
  it("parses well-formed JSON", () => {
    expect(parseToolInput('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("returns undefined for empty/whitespace with the default fallback", () => {
    expect(parseToolInput("")).toBeUndefined();
    expect(parseToolInput("   \n ")).toBeUndefined();
  });

  it("returns undefined for malformed JSON with the default fallback", () => {
    expect(parseToolInput('{"a":')).toBeUndefined();
    expect(parseToolInput("not json")).toBeUndefined();
  });

  it("returns {} for empty/malformed with the empty-object fallback (ACP)", () => {
    expect(parseToolInput("", "empty-object")).toEqual({});
    expect(parseToolInput('{"a":', "empty-object")).toEqual({});
  });

  it("still parses valid JSON regardless of fallback policy", () => {
    expect(parseToolInput('{"k":true}', "empty-object")).toEqual({ k: true });
  });
});

describe("ToolInputAccumulator", () => {
  it("reassembles fragments across start → append → end", () => {
    const acc = new ToolInputAccumulator<string>();
    acc.start("t1", "bash");
    acc.append("t1", '{"cmd"');
    acc.append("t1", ':"ls"}');
    expect(acc.has("t1")).toBe(true);
    expect(acc.meta("t1")).toBe("bash");

    const closed = acc.end("t1");
    expect(closed).toEqual({ meta: "bash", raw: '{"cmd":"ls"}' });
    expect(parseToolInput(closed!.raw)).toEqual({ cmd: "ls" });
    // Closing removes the entry.
    expect(acc.has("t1")).toBe(false);
    expect(acc.end("t1")).toBeUndefined();
  });

  it("returns undefined from end() for an unknown id", () => {
    const acc = new ToolInputAccumulator<string>();
    expect(acc.end("nope")).toBeUndefined();
  });

  it("tolerates append without a prior start (lenient headless path)", () => {
    const acc = new ToolInputAccumulator();
    acc.append("t2", "{}");
    expect(acc.has("t2")).toBe(true);
    expect(acc.end("t2")).toEqual({ meta: undefined, raw: "{}" });
  });

  it("keeps concurrent calls isolated by id", () => {
    const acc = new ToolInputAccumulator<string>();
    acc.start("a", "read");
    acc.start("b", "write");
    acc.append("a", '{"p":1}');
    acc.append("b", '{"p":2}');
    expect(acc.end("a")).toEqual({ meta: "read", raw: '{"p":1}' });
    expect(acc.end("b")).toEqual({ meta: "write", raw: '{"p":2}' });
  });

  it("start() overwrites a stale buffer for the same id", () => {
    const acc = new ToolInputAccumulator<string>();
    acc.start("t", "old");
    acc.append("t", "garbage");
    acc.start("t", "new");
    expect(acc.end("t")).toEqual({ meta: "new", raw: "" });
  });
});
