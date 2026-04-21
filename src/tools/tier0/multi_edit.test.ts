import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { multiEditTool } from "./multi_edit.js";

function ctx(cwd: string) {
  return { cwd };
}

describe("multi_edit", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "multi_edit_test_"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies 3 sequential edits in order", async () => {
    const file = path.join(tmpDir, "a.txt");
    await fs.writeFile(file, "alpha beta gamma");
    const result = await multiEditTool.execute(
      {
        path: "a.txt",
        edits: [
          { old_string: "alpha", new_string: "A" },
          { old_string: "beta", new_string: "B" },
          { old_string: "gamma", new_string: "C" },
        ],
      },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("A B C");
  });

  it("supports chained edits where edit N+1 targets output of edit N", async () => {
    const file = path.join(tmpDir, "b.txt");
    await fs.writeFile(file, "hello world");
    const result = await multiEditTool.execute(
      {
        path: "b.txt",
        edits: [
          { old_string: "hello world", new_string: "greetings world" },
          { old_string: "greetings world", new_string: "greetings earth" },
        ],
      },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("greetings earth");
  });

  it("leaves the file unchanged when one edit fails validation", async () => {
    const file = path.join(tmpDir, "c.txt");
    const original = "line one\nline two\nline three";
    await fs.writeFile(file, original);
    const result = await multiEditTool.execute(
      {
        path: "c.txt",
        edits: [
          { old_string: "line one", new_string: "LINE ONE" },
          { old_string: "NONEXISTENT", new_string: "x" }, // will fail
          { old_string: "line three", new_string: "LINE THREE" },
        ],
      },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    const msg = (result as { status: "error"; message: string }).message;
    expect(msg).toMatch(/edit 1 failed/);
    expect(msg).toMatch(/no edits applied/);
    // File must be unchanged.
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("rejects an empty edits array (Zod validation)", async () => {
    const file = path.join(tmpDir, "d.txt");
    await fs.writeFile(file, "content");
    const result = await multiEditTool.execute(
      { path: "d.txt", edits: [] },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
  });

  it("rejects paths outside the workspace boundary", async () => {
    const result = await multiEditTool.execute(
      {
        path: "../../etc/passwd",
        edits: [{ old_string: "root", new_string: "hacked" }],
      },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /outside the workspace boundary/,
    );
  });

  it("rejects symlinks pointing outside the workspace", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "swc-outside-"));
    const outsideFile = path.join(outsideDir, "target.txt");
    await fs.writeFile(outsideFile, "outside content");
    const linkPath = path.join(tmpDir, "escape-link");
    await fs.symlink(outsideFile, linkPath);

    const result = await multiEditTool.execute(
      {
        path: "escape-link",
        edits: [{ old_string: "outside", new_string: "hacked" }],
      },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /symlink|outside the workspace boundary/i,
    );
    const actual = await fs.readFile(outsideFile, "utf8");
    expect(actual).toBe("outside content");
  });

  it("returns error (not panic) when a mid-batch edit has ambiguous old_string", async () => {
    const file = path.join(tmpDir, "e.txt");
    await fs.writeFile(file, "x x x\ny\nz");
    const result = await multiEditTool.execute(
      {
        path: "e.txt",
        edits: [
          { old_string: "y", new_string: "Y" },
          { old_string: "x", new_string: "X" }, // 'x' appears 3 times
        ],
      },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    const msg = (result as { status: "error"; message: string }).message;
    expect(msg).toMatch(/edit 1 failed/);
    expect(msg).toMatch(/replace_all/);
  });
});
