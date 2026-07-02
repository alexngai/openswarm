import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatchTool, parsePatch } from "./apply_patch.js";
import type { ToolExecutionContext } from "../types.js";

let dir: string;
function ctx(): ToolExecutionContext {
  return { cwd: dir };
}
function read(p: string): string {
  return fs.readFileSync(path.join(dir, p), "utf8");
}
function write(p: string, content: string): void {
  const full = path.join(dir, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applypatch-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parsePatch", () => {
  it("parses add/update/delete with a move", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+hello",
      "*** Update File: b.txt",
      "*** Move to: c.txt",
      "@@",
      " keep",
      "-old",
      "+new",
      "*** Delete File: d.txt",
      "*** End Patch",
    ].join("\n");
    const r = parsePatch(patch);
    expect(r.error).toBeUndefined();
    expect(r.ops).toHaveLength(3);
    expect(r.ops![0]).toEqual({ kind: "add", path: "a.txt", content: "hello" });
    const upd = r.ops![1] as Extract<(typeof r.ops)[number], { kind: "update" }>;
    expect(upd.kind).toBe("update");
    expect(upd.moveTo).toBe("c.txt");
    expect(upd.chunks[0]).toEqual({ find: "keep\nold", replace: "keep\nnew" });
    expect(r.ops![2]).toEqual({ kind: "delete", path: "d.txt" });
  });

  it("errors on missing envelope and bad add lines", () => {
    expect(parsePatch("nope").error).toContain("Begin Patch");
    const bad = ["*** Begin Patch", "*** Add File: a.txt", "no-plus", "*** End Patch"].join("\n");
    expect(parsePatch(bad).error).toContain("must start with");
  });
});

describe("apply_patch execute", () => {
  it("adds a new file", async () => {
    const patch = ["*** Begin Patch", "*** Add File: sub/new.txt", "+line1", "+line2", "*** End Patch"].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("ok");
    expect(read("sub/new.txt")).toBe("line1\nline2");
  });

  it("refuses to add over an existing file (atomic: nothing applied)", async () => {
    write("exists.txt", "orig");
    const patch = [
      "*** Begin Patch",
      "*** Add File: fresh.txt",
      "+ok",
      "*** Add File: exists.txt",
      "+should not happen",
      "*** End Patch",
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("error");
    expect(read("exists.txt")).toBe("orig");
    expect(fs.existsSync(path.join(dir, "fresh.txt"))).toBe(false);
  });

  it("updates a file via context hunk", async () => {
    write("app.ts", "function greet() {\n  print('Hi')\n}\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: app.ts",
      "@@",
      "-  print('Hi')",
      "+  print('Hello, world!')",
      "*** End Patch",
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("ok");
    expect(read("app.ts")).toBe("function greet() {\n  print('Hello, world!')\n}\n");
  });

  it("fails an ambiguous update without applying", async () => {
    write("dup.txt", "x\nx\n");
    const patch = ["*** Begin Patch", "*** Update File: dup.txt", "@@", "-x", "+y", "*** End Patch"].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("matches");
    expect(read("dup.txt")).toBe("x\nx\n");
  });

  it("updates with a rename (move)", async () => {
    write("old.ts", "const a = 1\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.ts",
      "*** Move to: renamed.ts",
      "@@",
      "-const a = 1",
      "+const a = 2",
      "*** End Patch",
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("ok");
    expect(fs.existsSync(path.join(dir, "old.ts"))).toBe(false);
    expect(read("renamed.ts")).toBe("const a = 2\n");
  });

  it("deletes a file", async () => {
    write("gone.txt", "bye");
    const patch = ["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch"].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("ok");
    expect(fs.existsSync(path.join(dir, "gone.txt"))).toBe(false);
  });

  it("applies multiple files in one atomic patch", async () => {
    write("keep.ts", "let v = 0\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.ts",
      "+export const x = 1",
      "*** Update File: keep.ts",
      "@@",
      "-let v = 0",
      "+let v = 42",
      "*** End Patch",
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("ok");
    expect(read("added.ts")).toBe("export const x = 1");
    expect(read("keep.ts")).toBe("let v = 42\n");
  });

  it("rejects paths outside the workspace boundary", async () => {
    const patch = ["*** Begin Patch", "*** Add File: ../escape.txt", "+nope", "*** End Patch"].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("workspace boundary");
  });

  it("errors clearly on a non-existent update target", async () => {
    const patch = ["*** Begin Patch", "*** Update File: missing.ts", "@@", "-a", "+b", "*** End Patch"].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("failed to read");
  });
});
