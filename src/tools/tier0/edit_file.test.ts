import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { editFileTool } from "./edit_file.js";

function ctx(cwd: string) {
  return { cwd };
}

describe("edit_file", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit_file_test_"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("replaces a single occurrence", async () => {
    const file = path.join(tmpDir, "a.txt");
    await fs.writeFile(file, "hello world");
    const result = await editFileTool.execute(
      { path: "a.txt", old_string: "world", new_string: "there" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("hello there");
  });

  it("returns error when old_string is not found", async () => {
    const file = path.join(tmpDir, "b.txt");
    await fs.writeFile(file, "hello world");
    const result = await editFileTool.execute(
      { path: "b.txt", old_string: "missing", new_string: "x" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /old_string not found/,
    );
  });

  it("returns error when old_string appears multiple times without replace_all", async () => {
    const file = path.join(tmpDir, "c.txt");
    await fs.writeFile(file, "foo foo foo");
    const result = await editFileTool.execute(
      { path: "c.txt", old_string: "foo", new_string: "bar" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    const msg = (result as { status: "error"; message: string }).message;
    expect(msg).toMatch(/3 times/);
    expect(msg).toMatch(/replace_all/);
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const file = path.join(tmpDir, "d.txt");
    await fs.writeFile(file, "foo foo foo");
    const result = await editFileTool.execute(
      { path: "d.txt", old_string: "foo", new_string: "bar", replace_all: true },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("bar bar bar");
  });

  it("roundtrip: new content differs from old after replacement", async () => {
    const file = path.join(tmpDir, "e.txt");
    const original = "the quick brown fox";
    await fs.writeFile(file, original);
    await editFileTool.execute(
      { path: "e.txt", old_string: "brown", new_string: "lazy" },
      ctx(tmpDir),
    );
    const updated = await fs.readFile(file, "utf8");
    expect(updated).toBe("the quick lazy fox");
    expect(updated).not.toBe(original);
  });

  it("rejects paths outside the workspace boundary", async () => {
    const result = await editFileTool.execute(
      { path: "../../etc/passwd", old_string: "root", new_string: "hacked" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /outside the workspace boundary/,
    );
  });

  it("rejects symlinks pointing outside the workspace", async () => {
    // Write a real file outside tmpDir, symlink to it from inside.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "swc-outside-"));
    const outsideFile = path.join(outsideDir, "target.txt");
    await fs.writeFile(outsideFile, "outside content");
    const linkPath = path.join(tmpDir, "escape-link");
    await fs.symlink(outsideFile, linkPath);

    const result = await editFileTool.execute(
      { path: "escape-link", old_string: "outside", new_string: "hacked" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /symlink|outside the workspace boundary/i,
    );

    // Confirm the real outside file was not modified.
    const actual = await fs.readFile(outsideFile, "utf8");
    expect(actual).toBe("outside content");
  });

  it("replace_all: true still works when there is only one match", async () => {
    const file = path.join(tmpDir, "f.txt");
    await fs.writeFile(file, "only once here");
    const result = await editFileTool.execute(
      { path: "f.txt", old_string: "once", new_string: "1", replace_all: true },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("only 1 here");
  });
});
