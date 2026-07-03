import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileTool } from "./write_file.js";
import { recordFileRead, clearReadState } from "./read-state.js";
import type { ToolExecutionContext } from "../types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-file-test-"));
  clearReadState();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(): ToolExecutionContext {
  return { cwd: tmpDir };
}

describe("writeFileTool", () => {
  it("writes a file and content can be re-read", async () => {
    const result = await writeFileTool.execute(
      { file_path: "hello.txt", content: "hello world" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("File created successfully");
      expect(result.output).toContain("hello.txt");
    }
    const content = fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf8");
    expect(content).toBe("hello world");
  });

  it("requires read-before-overwrite for existing files", async () => {
    const file = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(file, "original");

    const denied = await writeFileTool.execute(
      { file_path: "existing.txt", content: "overwritten" },
      ctx(),
    );
    expect(denied.status).toBe("error");
    if (denied.status === "error") {
      expect(denied.message).toContain("has not been read yet");
    }
    expect(fs.readFileSync(file, "utf8")).toBe("original");

    recordFileRead(file);
    const allowed = await writeFileTool.execute(
      { file_path: "existing.txt", content: "overwritten" },
      ctx(),
    );
    expect(allowed.status).toBe("ok");
    if (allowed.status === "ok") {
      expect(allowed.output).toContain("has been updated");
    }
    expect(fs.readFileSync(file, "utf8")).toBe("overwritten");
  });

  it("creates missing parent directories", async () => {
    const result = await writeFileTool.execute(
      { path: "a/b/c/file.txt", content: "nested" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    const content = fs.readFileSync(path.join(tmpDir, "a/b/c/file.txt"), "utf8");
    expect(content).toBe("nested");
  });

  it("rejects paths that escape the workspace boundary", async () => {
    const result = await writeFileTool.execute(
      { path: "../outside.txt", content: "escape" },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("path escapes workspace");
    }
  });

  it("rejects content exceeding 10 MiB", async () => {
    // 10 MiB + 1 byte of 'A'.
    const big = "A".repeat(10 * 1024 * 1024 + 1);
    const result = await writeFileTool.execute(
      { path: "big.txt", content: big },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("10 MiB");
    }
  });

  it("rejects symlinks pointing outside workspace", async () => {
    // Create a symlink inside tmpDir that points to /tmp (outside tmpDir).
    const linkPath = path.join(tmpDir, "link.txt");
    fs.symlinkSync("/tmp", linkPath);

    const result = await writeFileTool.execute(
      { path: "link.txt", content: "escape via symlink" },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("path escapes workspace");
    }
  });

  it("uses atomic rename: no temp file remains after write", async () => {
    const result = await writeFileTool.execute(
      { path: "atomic.txt", content: "atomic content" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    // Final file exists with correct content.
    const content = fs.readFileSync(path.join(tmpDir, "atomic.txt"), "utf8");
    expect(content).toBe("atomic content");
    // No stray .tmp- files left in the directory.
    const entries = fs.readdirSync(tmpDir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp-"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("invalid input returns error", async () => {
    const result = await writeFileTool.execute({ path: 123, content: "x" }, ctx());
    expect(result.status).toBe("error");
  });
});
