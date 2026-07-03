import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { editFileTool } from "./edit_file.js";
import { recordFileRead, clearReadState } from "./read-state.js";

function ctx(cwd: string) {
  return { cwd };
}

describe("edit_file", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit_file_test_"));
    clearReadState();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Create a file and mark it read (edit requires read-before-edit). */
  async function writeAndRead(name: string, content: string): Promise<string> {
    const file = path.join(tmpDir, name);
    await fs.writeFile(file, content);
    recordFileRead(file);
    return file;
  }

  it("replaces a single occurrence and returns the Claude Code success sentence", async () => {
    const file = await writeAndRead("a.txt", "hello world");
    const result = await editFileTool.execute(
      { file_path: "a.txt", old_string: "world", new_string: "there" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("hello there");
    if (result.status === "ok") {
      expect(result.output).toBe(
        "The file a.txt has been updated successfully." +
          " (file state is current in your context \u2014 no need to Read it back)",
      );
    }
  });

  it("accepts legacy `path` alias for file_path", async () => {
    const file = await writeAndRead("alias.txt", "hello world");
    const result = await editFileTool.execute(
      { path: "alias.txt", old_string: "world", new_string: "there" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("hello there");
  });

  it("rejects edits to files that have not been read", async () => {
    await fs.writeFile(path.join(tmpDir, "unread.txt"), "hello world");
    const result = await editFileTool.execute(
      { file_path: "unread.txt", old_string: "world", new_string: "there" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /has not been read yet/,
    );
  });

  it("rejects no-op edits where old_string equals new_string", async () => {
    await writeAndRead("noop.txt", "hello world");
    const result = await editFileTool.execute(
      { file_path: "noop.txt", old_string: "world", new_string: "world" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /exactly the same/,
    );
  });

  it("returns error when old_string is not found", async () => {
    await writeAndRead("b.txt", "hello world");
    const result = await editFileTool.execute(
      { file_path: "b.txt", old_string: "missing", new_string: "x" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /String to replace not found in file/,
    );
  });

  it("returns error when old_string appears multiple times without replace_all", async () => {
    await writeAndRead("c.txt", "foo foo foo");
    const result = await editFileTool.execute(
      { file_path: "c.txt", old_string: "foo", new_string: "bar" },
      ctx(tmpDir),
    );
    expect(result.status).toBe("error");
    const msg = (result as { status: "error"; message: string }).message;
    expect(msg).toMatch(/Found 3 matches/);
    expect(msg).toMatch(/replace_all/);
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const file = await writeAndRead("d.txt", "foo foo foo");
    const result = await editFileTool.execute(
      { file_path: "d.txt", old_string: "foo", new_string: "bar", replace_all: true },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("bar bar bar");
    if (result.status === "ok") {
      expect(result.output).toContain("All occurrences were successfully replaced.");
    }
  });

  it("roundtrip: new content differs from old after replacement", async () => {
    const file = await writeAndRead("e.txt", "the quick brown fox");
    await editFileTool.execute(
      { file_path: "e.txt", old_string: "brown", new_string: "lazy" },
      ctx(tmpDir),
    );
    const updated = await fs.readFile(file, "utf8");
    expect(updated).toBe("the quick lazy fox");
    expect(updated).not.toBe("the quick brown fox");
  });

  it("rejects paths outside the workspace boundary", async () => {
    const result = await editFileTool.execute(
      { file_path: "../../etc/passwd", old_string: "root", new_string: "hacked" },
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
      { file_path: "escape-link", old_string: "outside", new_string: "hacked" },
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
    const file = await writeAndRead("f.txt", "only once here");
    const result = await editFileTool.execute(
      { file_path: "f.txt", old_string: "once", new_string: "1", replace_all: true },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    expect(await fs.readFile(file, "utf8")).toBe("only 1 here");
  });

  it("detects TOCTTOU: file modified between read and write", async () => {
    const file = await writeAndRead("tocttou.txt", "original content");

    // Start the edit — it will read "original content" and compute a hash.
    // Concurrently modify the file after a short delay to simulate a race.
    const editPromise = editFileTool.execute(
      { file_path: "tocttou.txt", old_string: "original", new_string: "replaced" },
      ctx(tmpDir),
    );

    // The atomicWrite TOCTTOU check re-reads the file right before rename.
    // Since we can't intercept rename, we test the underlying protection
    // by verifying that if the file content doesn't match the expected hash,
    // the error propagates correctly.
    // We do this by importing and testing atomicWrite directly.
    const { atomicWrite, TocttouError } = await import("./edit_file.js");
    const crypto = await import("node:crypto");

    // Wait for the edit to complete (it should succeed since no actual race)
    const result = await editPromise;
    expect(result.status).toBe("ok");

    // Now test atomicWrite with a wrong expectedHash
    const wrongHash = crypto.createHash("sha256").update("different content").digest("hex");
    await fs.writeFile(file, "current content");
    try {
      await atomicWrite(file, "new content", wrongHash);
      expect.fail("should have thrown TocttouError");
    } catch (err) {
      expect(err).toBeInstanceOf(TocttouError);
      expect((err as Error).message).toMatch(/modified between read and write/);
    }
  });
});
