import { describe, it, expect } from "vitest";
import {
  toolKind,
  toolTitle,
  toolLocations,
  diffContent,
  isEditTool,
} from "./tool-kind.js";

describe("tool-kind", () => {
  it("maps known tool names to ACP kinds, unknown to other", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("edit_file")).toBe("edit");
    expect(toolKind("write_file")).toBe("edit");
    expect(toolKind("bash")).toBe("execute");
    expect(toolKind("grep")).toBe("search");
    expect(toolKind("glob")).toBe("search");
    expect(toolKind("nonexistent")).toBe("other");
  });

  it("builds read locations with a 1-based line from the 0-based offset", () => {
    expect(toolLocations("read_file", { path: "a.ts", offset: 4 })).toEqual([
      { path: "a.ts", line: 5 },
    ]);
    expect(toolLocations("read_file", { path: "a.ts" })).toEqual([
      { path: "a.ts" },
    ]);
    expect(toolLocations("edit_file", { path: "a.ts" })).toEqual([
      { path: "a.ts" },
    ]);
    expect(toolLocations("grep", { pattern: "x" })).toBeUndefined();
  });

  it("synthesizes diffs for edit-family tools", () => {
    expect(
      diffContent("edit_file", { path: "a.ts", old_string: "x", new_string: "y" }),
    ).toEqual([{ type: "diff", path: "a.ts", oldText: "x", newText: "y" }]);

    expect(diffContent("write_file", { path: "a.ts", content: "hello" })).toEqual([
      { type: "diff", path: "a.ts", oldText: null, newText: "hello" },
    ]);

    const md = diffContent("multi_edit", {
      path: "a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    });
    expect(md).toHaveLength(2);
    expect(md?.[1]).toEqual({
      type: "diff",
      path: "a.ts",
      oldText: "c",
      newText: "d",
    });

    expect(diffContent("read_file", { path: "a.ts" })).toBeUndefined();
  });

  it("titles tools readably", () => {
    expect(toolTitle("read_file", { path: "x.ts" })).toBe("Read x.ts");
    expect(toolTitle("edit_file", { path: "x.ts" })).toBe("Edit x.ts");
    expect(toolTitle("bash", { command: "ls -la" })).toBe("$ ls -la");
    expect(toolTitle("read_file", {})).toBe("Read file");
  });

  it("classifies edit tools", () => {
    expect(isEditTool("edit_file")).toBe(true);
    expect(isEditTool("write_file")).toBe(true);
    expect(isEditTool("multi_edit")).toBe(true);
    expect(isEditTool("read_file")).toBe(false);
  });
});
