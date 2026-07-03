import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileTool } from "./read_file.js";
import type { ToolExecutionContext } from "../types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(): ToolExecutionContext {
  return { cwd: tmpDir };
}

function write(name: string, content: string | Buffer): string {
  const p = path.join(tmpDir, name);
  if (typeof content === "string") {
    fs.writeFileSync(p, content, "utf8");
  } else {
    fs.writeFileSync(p, content);
  }
  return p;
}

describe("readFileTool", () => {
  it("reads a small text file with cat-n formatting", async () => {
    write("hello.txt", "line one\nline two\nline three\n");
    const result = await readFileTool.execute({ file_path: "hello.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("  1\tline one");
      expect(result.output).toContain("  2\tline two");
      expect(result.output).toContain("  3\tline three");
    }
  });

  it("accepts legacy `path` alias for file_path", async () => {
    write("alias.txt", "aliased\n");
    const result = await readFileTool.execute({ path: "alias.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("aliased");
    }
  });

  it("applies offset (1-based line number) and limit correctly", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    write("lines.txt", lines + "\n");
    const result = await readFileTool.execute(
      { file_path: "lines.txt", offset: 2, limit: 3 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // offset 2 = start reading from line 2 (Claude Code convention).
      expect(result.output).toContain("  2\tline 2");
      expect(result.output).toContain("  3\tline 3");
      expect(result.output).toContain("  4\tline 4");
      expect(result.output).not.toContain("\tline 5");
      // Continuation hint points at the next unread line.
      expect(result.output).toContain("Use offset=5 to continue");
    }
  });

  it("returns error for non-existent file", async () => {
    const result = await readFileTool.execute({ file_path: "does-not-exist.txt" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("File does not exist");
    }
  });

  it("detects binary file (NUL byte in first 8 KiB)", async () => {
    const buf = Buffer.alloc(100, 0x41); // 'A' repeated
    buf[50] = 0x00; // NUL byte
    write("binary.bin", buf);
    const result = await readFileTool.execute({ path: "binary.bin" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("binary file detected");
    }
  });

  it("rejects files larger than 10 MiB", async () => {
    // Create a file slightly over 10 MiB.
    const bigBuf = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    write("big.txt", bigBuf);
    const result = await readFileTool.execute({ path: "big.txt" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("10 MiB");
    }
  }, 10000);

  it("returns the Claude Code system-reminder for an empty file", async () => {
    write("empty.txt", "");
    const result = await readFileTool.execute({ file_path: "empty.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe(
        "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
      );
    }
  });

  it("returns the Claude Code system-reminder when offset is past EOF", async () => {
    write("short.txt", "one\ntwo\n");
    const result = await readFileTool.execute(
      { file_path: "short.txt", offset: 10 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe(
        "<system-reminder>Warning: the file exists but is shorter than the provided offset " +
          "(10). The file has 2 lines.</system-reminder>",
      );
    }
  });

  it("preserves UTF-8 multi-byte content", async () => {
    write("unicode.txt", "こんにちは\n世界\n");
    const result = await readFileTool.execute({ path: "unicode.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("こんにちは");
      expect(result.output).toContain("世界");
    }
  });

  it("uses default limit of 2000 lines and prepends a PARTIAL-view reminder", async () => {
    // Write 2500 lines and confirm we only get 2000 back plus the reminder.
    const content = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
    write("many.txt", content);
    const result = await readFileTool.execute({ file_path: "many.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("\tline 2000");
      expect(result.output).not.toContain("\tline 2001");
      expect(
        result.output.startsWith(
          "<system-reminder>[Truncated: PARTIAL view \u2014 showing lines 1-2000 of 2500 total.",
        ),
      ).toBe(true);
      expect(result.output).toContain("offset=2001");
    }
  });

  it("explicit limit truncation appends a plain continuation hint", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    write("windowed.txt", content);
    const result = await readFileTool.execute(
      { file_path: "windowed.txt", offset: 1, limit: 10 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain(
        "(Showing lines 1-10 of 50. Use offset=11 to continue.)",
      );
    }
  });

  it("truncates very long lines", async () => {
    write("long-line.txt", "x".repeat(3000) + "\nshort\n");
    const result = await readFileTool.execute({ file_path: "long-line.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("(line truncated to 2000 chars)");
      expect(result.output).toContain("short");
    }
  });

  it("invalid input returns error", async () => {
    const result = await readFileTool.execute({ file_path: 123 }, ctx());
    expect(result.status).toBe("error");
  });
});
