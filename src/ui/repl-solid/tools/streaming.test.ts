import { describe, it, expect } from "vitest";
import { extractPartialJsonField, getStreamingArg } from "./streaming.js";

describe("extractPartialJsonField", () => {
  it("extracts complete field value", () => {
    const json = '{"file_path": "src/main.ts", "content": "hello"}';
    expect(extractPartialJsonField(json, "file_path")).toBe("src/main.ts");
    expect(extractPartialJsonField(json, "content")).toBe("hello");
  });

  it("extracts from truncated JSON (no closing brace)", () => {
    const json = '{"file_path": "src/main.ts", "old_str';
    expect(extractPartialJsonField(json, "file_path")).toBe("src/main.ts");
  });

  it("extracts truncated value", () => {
    const json = '{"file_path": "src/ma';
    expect(extractPartialJsonField(json, "file_path")).toBe("src/ma");
  });

  it("returns undefined when field not yet seen", () => {
    const json = '{"com';
    expect(extractPartialJsonField(json, "file_path")).toBeUndefined();
  });

  it("handles escaped quotes in value", () => {
    const json = '{"command": "echo \\"hello\\""}';
    expect(extractPartialJsonField(json, "command")).toBe('echo "hello"');
  });

  it("handles newline escapes", () => {
    const json = '{"content": "line1\\nline2"}';
    expect(extractPartialJsonField(json, "content")).toBe("line1\nline2");
  });

  it("handles empty string value", () => {
    const json = '{"file_path": ""}';
    expect(extractPartialJsonField(json, "file_path")).toBe("");
  });

  it("handles field with no value started", () => {
    const json = '{"file_path": "';
    expect(extractPartialJsonField(json, "file_path")).toBeUndefined();
  });

  it("handles multiple fields — extracts the first occurrence", () => {
    const json = '{"a": "first", "b": "second", "a": "third"}';
    expect(extractPartialJsonField(json, "a")).toBe("first");
    expect(extractPartialJsonField(json, "b")).toBe("second");
  });
});

describe("getStreamingArg", () => {
  it("uses full parse when JSON is complete", () => {
    const json = '{"file_path": "src/index.ts"}';
    expect(getStreamingArg(json, "file_path")).toBe("src/index.ts");
  });

  it("falls back to partial extraction for incomplete JSON", () => {
    const json = '{"file_path": "src/index.ts", "old_str';
    expect(getStreamingArg(json, "file_path")).toBe("src/index.ts");
  });

  it("returns undefined for empty streamingArgs", () => {
    expect(getStreamingArg("", "file_path")).toBeUndefined();
  });

  it("returns undefined when field not found in complete JSON", () => {
    const json = '{"command": "ls"}';
    expect(getStreamingArg(json, "file_path")).toBeUndefined();
  });
});
