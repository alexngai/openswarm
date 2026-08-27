import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { globTool } from "./glob.js";

function ctx(cwd: string) {
  return { cwd };
}

describe("glob", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob_test_"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("matches *.ts files in a flat fixture directory", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), "");
    await fs.writeFile(path.join(tmpDir, "b.ts"), "");
    await fs.writeFile(path.join(tmpDir, "c.js"), "");

    const result = await globTool.execute({ pattern: "*.ts" }, ctx(tmpDir));
    expect(result.status).toBe("ok");
    const lines = (result as { status: "ok"; output: string }).output
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith(".ts"))).toBe(true);
  });

  it("matches **/*.ts recursively", async () => {
    const sub = path.join(tmpDir, "sub");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(tmpDir, "root.ts"), "");
    await fs.writeFile(path.join(sub, "nested.ts"), "");
    await fs.writeFile(path.join(sub, "other.js"), "");

    const result = await globTool.execute({ pattern: "**/*.ts" }, ctx(tmpDir));
    expect(result.status).toBe("ok");
    const lines = (result as { status: "ok"; output: string }).output
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith(".ts"))).toBe(true);
  });

  it("returns 'No files found' when no files match", async () => {
    await fs.writeFile(path.join(tmpDir, "a.js"), "");

    const result = await globTool.execute({ pattern: "*.ts" }, ctx(tmpDir));
    expect(result.status).toBe("ok");
    const output = (result as { status: "ok"; output: string }).output;
    expect(output).toBe("No files found");
  });

  it("respects .gitignore patterns", async () => {
    // Create a .gitignore that ignores *.log files.
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "*.log\n");
    await fs.writeFile(path.join(tmpDir, "app.ts"), "");
    await fs.writeFile(path.join(tmpDir, "debug.log"), "");
    await fs.writeFile(path.join(tmpDir, "error.log"), "");

    const result = await globTool.execute({ pattern: "**/*" }, ctx(tmpDir));
    expect(result.status).toBe("ok");
    const lines = (result as { status: "ok"; output: string }).output
      .split("\n")
      .filter(Boolean);
    // Should include app.ts but not the .log files.
    expect(lines.some((l) => l.endsWith("app.ts"))).toBe(true);
    expect(lines.some((l) => l.endsWith(".log"))).toBe(false);
  });

  it("honors the cwd input override", async () => {
    const sub = path.join(tmpDir, "sub");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "inside.ts"), "");
    await fs.writeFile(path.join(tmpDir, "outside.ts"), "");

    const result = await globTool.execute(
      { pattern: "*.ts", cwd: sub },
      ctx(tmpDir),
    );
    expect(result.status).toBe("ok");
    const lines = (result as { status: "ok"; output: string }).output
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("inside.ts");
  });
});
