import { describe, it, expect } from "vitest";
import { getRenderer } from "./registry.js";
import type { ToolCallState } from "../../repl/state.js";

function makeTc(overrides: Partial<ToolCallState> & { name: string }): ToolCallState {
  return {
    id: "tc-1",
    streamingArgs: "",
    args: undefined,
    result: undefined,
    isError: false,
    pending: true,
    ...overrides,
  };
}

describe("tool renderers — chip", () => {
  it("bash chip shows exit:0 on success", () => {
    const r = getRenderer("bash");
    const tc = makeTc({ name: "bash", pending: false, result: "output" });
    expect(r.chip(tc)).toBe("exit:0");
  });

  it("bash chip shows exit:1 on error", () => {
    const r = getRenderer("bash");
    const tc = makeTc({ name: "bash", pending: false, result: "err", isError: true });
    expect(r.chip(tc)).toBe("exit:1");
  });

  it("bash chip is empty while pending", () => {
    const r = getRenderer("bash");
    const tc = makeTc({ name: "bash" });
    expect(r.chip(tc)).toBe("");
  });

  it("read_file chip shows line count", () => {
    const r = getRenderer("read_file");
    const tc = makeTc({ name: "read_file", pending: false, result: "a\nb\nc" });
    expect(r.chip(tc)).toBe("3 lines");
  });

  it("edit_file chip shows diff stats", () => {
    const r = getRenderer("edit_file");
    const tc = makeTc({
      name: "edit_file",
      pending: false,
      result: "ok",
      args: { file_path: "f.ts", old_string: "a\nb", new_string: "a\nb\nc" },
    });
    expect(r.chip(tc)).toBe("+3 -2");
  });

  it("write_file chip shows line count from content arg", () => {
    const r = getRenderer("write_file");
    const tc = makeTc({
      name: "write_file",
      pending: false,
      result: "ok",
      args: { file_path: "f.ts", content: "line1\nline2\nline3\nline4" },
    });
    expect(r.chip(tc)).toBe("4 lines");
  });

  it("grep chip shows match count", () => {
    const r = getRenderer("grep");
    const tc = makeTc({
      name: "grep",
      pending: false,
      result: "src/a.ts:10:match\nsrc/b.ts:5:match\n",
    });
    expect(r.chip(tc)).toBe("2 matches");
  });

  it("glob chip shows file count", () => {
    const r = getRenderer("glob");
    const tc = makeTc({
      name: "glob",
      pending: false,
      result: "a.ts\nb.ts\nc.ts",
    });
    expect(r.chip(tc)).toBe("3 files");
  });

  it("unknown tool uses generic renderer", () => {
    const r = getRenderer("some_unknown_tool");
    const tc = makeTc({ name: "some_unknown_tool", pending: false, result: "x" });
    expect(r.chip(tc)).toBe("");
  });
});

describe("tool renderers — keyArg", () => {
  it("bash extracts first line of command", () => {
    const r = getRenderer("bash");
    const tc = makeTc({
      name: "bash",
      args: { command: "ls -la\necho hello" },
    });
    expect(r.keyArg(tc)).toBe("ls -la");
  });

  it("read_file extracts file_path", () => {
    const r = getRenderer("read_file");
    const tc = makeTc({
      name: "read_file",
      args: { file_path: "src/main.ts" },
    });
    expect(r.keyArg(tc)).toBe("src/main.ts");
  });

  it("grep extracts pattern", () => {
    const r = getRenderer("grep");
    const tc = makeTc({
      name: "grep",
      args: { pattern: "TODO" },
    });
    expect(r.keyArg(tc)).toBe("TODO");
  });

  it("generic extracts first arg value", () => {
    const r = getRenderer("unknown");
    const tc = makeTc({
      name: "unknown",
      args: { foo: "bar", baz: "qux" },
    });
    expect(r.keyArg(tc)).toBe("bar");
  });

  it("truncates long key args to 60 chars", () => {
    const r = getRenderer("bash");
    const longCmd = "x".repeat(100);
    const tc = makeTc({ name: "bash", args: { command: longCmd } });
    expect(r.keyArg(tc).length).toBeLessThanOrEqual(61); // 60 + "…"
  });
});

describe("tool renderers — bodyLines", () => {
  it("bash body shows command and output", () => {
    const r = getRenderer("bash");
    const tc = makeTc({
      name: "bash",
      pending: false,
      args: { command: "echo hi" },
      result: "hi",
    });
    const lines = r.bodyLines(tc);
    expect(lines.some((l) => l.includes("$ echo hi"))).toBe(true);
    expect(lines.some((l) => l.includes("hi"))).toBe(true);
  });

  it("edit body shows diff lines", () => {
    const r = getRenderer("edit_file");
    const tc = makeTc({
      name: "edit_file",
      pending: false,
      args: { file_path: "f.ts", old_string: "old", new_string: "new" },
      result: "ok",
    });
    const lines = r.bodyLines(tc);
    expect(lines.some((l) => l.startsWith("- "))).toBe(true);
    expect(lines.some((l) => l.startsWith("+ "))).toBe(true);
  });

  it("grep body shows sample matches", () => {
    const r = getRenderer("grep");
    const tc = makeTc({
      name: "grep",
      pending: false,
      args: { pattern: "TODO" },
      result: "a.ts:1:TODO\nb.ts:2:TODO\nc.ts:3:TODO\nd.ts:4:TODO\ne.ts:5:TODO\nf.ts:6:TODO",
    });
    const lines = r.bodyLines(tc);
    expect(lines.length).toBeLessThanOrEqual(6); // 5 sample + "… +1 more"
  });
});
