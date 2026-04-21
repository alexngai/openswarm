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
    const result = await readFileTool.execute({ path: "hello.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("  1\tline one");
      expect(result.output).toContain("  2\tline two");
      expect(result.output).toContain("  3\tline three");
    }
  });

  it("applies offset and limit correctly", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    write("lines.txt", lines + "\n");
    const result = await readFileTool.execute(
      { path: "lines.txt", offset: 2, limit: 3 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // offset 2 means skip lines 1-2, start from line 3 (1-indexed display: 3)
      expect(result.output).toContain("  3\tline 3");
      expect(result.output).toContain("  4\tline 4");
      expect(result.output).toContain("  5\tline 5");
      expect(result.output).not.toContain("line 6");
    }
  });

  it("returns error for non-existent file", async () => {
    const result = await readFileTool.execute({ path: "does-not-exist.txt" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("cannot stat file");
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

  it("handles empty file gracefully", async () => {
    write("empty.txt", "");
    const result = await readFileTool.execute({ path: "empty.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("");
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

  it("uses default limit of 2000 lines", async () => {
    // Write 2500 lines and confirm we only get 2000 back.
    const content = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
    write("many.txt", content);
    const result = await readFileTool.execute({ path: "many.txt" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const lineCount = result.output.split("\n").length;
      expect(lineCount).toBe(2000);
    }
  });

  it("invalid input returns error", async () => {
    const result = await readFileTool.execute({ path: 123 }, ctx());
    expect(result.status).toBe("error");
  });
});
