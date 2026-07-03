import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { grepTool } from "./grep.js";
import type { ToolExecutionContext } from "../types.js";

let tmpDir: string;

const ctx = (): ToolExecutionContext => ({ cwd: tmpDir });

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "grep-test-"));

  // Initialize a git repo so ripgrep respects .gitignore
  execSync("git init -q", { cwd: tmpDir });

  // Fixture files
  await writeFile(join(tmpDir, "alpha.ts"), "export const foo = 'hello';\nexport const bar = 'world';\n");
  await writeFile(join(tmpDir, "beta.ts"), "const hello = 42;\n// hello world\n");
  await writeFile(join(tmpDir, "gamma.txt"), "HELLO uppercase\ngoodbye\n");
  await writeFile(join(tmpDir, "delta.js"), "console.log('delta');\n// no match here\n");

  // Subdirectory for gitignore test
  await mkdir(join(tmpDir, "ignored-dir"));
  await writeFile(join(tmpDir, "ignored-dir", "secret.ts"), "const secret = 'hello';\n");

  // .gitignore that ignores ignored-dir
  await writeFile(join(tmpDir, ".gitignore"), "ignored-dir/\n");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("grep tool — content mode", () => {
  it("finds matches and formats as path:line: text", async () => {
    const result = await grepTool.execute({ pattern: "hello" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // alpha.ts line 1 and beta.ts both contain 'hello'
    expect(result.output).toContain("alpha.ts:1:");
    expect(result.output).toContain("hello");
  });

  it("returns 'No matches found' when no matches", async () => {
    const result = await grepTool.execute({ pattern: "ZZZNOMATCH_XYZ" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toBe("No matches found");
  });

  it("returns 'No files found' for files_with_matches mode with no matches", async () => {
    const result = await grepTool.execute(
      { pattern: "ZZZNOMATCH_XYZ", output_mode: "files_with_matches" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toBe("No files found");
  });

  it("respects case_insensitive flag", async () => {
    // Without flag, 'HELLO' won't match 'hello' files
    const caseSensitive = await grepTool.execute({ pattern: "HELLO", output_mode: "files_with_matches" }, ctx());
    expect(caseSensitive.status).toBe("ok");

    const caseInsensitive = await grepTool.execute({ pattern: "HELLO", case_insensitive: true, output_mode: "files_with_matches" }, ctx());
    expect(caseInsensitive.status).toBe("ok");
    if (caseInsensitive.status !== "ok" || caseSensitive.status !== "ok") return;

    // Case-insensitive should match more files than case-sensitive
    const ciLines = caseInsensitive.output.split("\n").filter(Boolean).length;
    const csLines = caseSensitive.output.split("\n").filter(Boolean).length;
    expect(ciLines).toBeGreaterThan(csLines);
  });
});

describe("grep tool — files_with_matches mode", () => {
  it("returns unique file paths only", async () => {
    const result = await grepTool.execute(
      { pattern: "hello", output_mode: "files_with_matches" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const lines = result.output.split("\n").filter(Boolean);
    // Should be unique paths
    const unique = new Set(lines);
    expect(unique.size).toBe(lines.length);
    // Should contain ts files with 'hello'
    expect(lines.some((l) => l.endsWith("alpha.ts"))).toBe(true);
    expect(lines.some((l) => l.endsWith("beta.ts"))).toBe(true);
  });
});

describe("grep tool — count mode", () => {
  it("returns match counts per file", async () => {
    const result = await grepTool.execute(
      { pattern: "hello", output_mode: "count" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const lines = result.output.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Raw rg `path:count` lines followed by Claude Code's total summary.
    const summary = lines[lines.length - 1]!;
    expect(summary).toMatch(/^Found \d+ total occurrences? across \d+ files?\.$/);
    for (const line of lines.slice(0, -1)) {
      expect(line).toMatch(/:\d+$/);
    }
  });
});

describe("grep tool — glob filter", () => {
  it("restricts search to matching file types", async () => {
    const result = await grepTool.execute(
      { pattern: "hello", glob: "*.txt" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    // gamma.txt has 'HELLO' but not lowercase 'hello', so no match
    // delta.js has no 'hello' — txt filter should produce no matches
    expect(result.output).toBe("No matches found");

    // Now search with case_insensitive to hit gamma.txt
    const result2 = await grepTool.execute(
      { pattern: "hello", glob: "*.txt", case_insensitive: true },
      ctx(),
    );
    expect(result2.status).toBe("ok");
    if (result2.status !== "ok") return;
    expect(result2.output).toContain("gamma.txt");
    expect(result2.output).not.toContain("alpha.ts");
    expect(result2.output).not.toContain("beta.ts");
  });
});

describe("grep tool — .gitignore respected", () => {
  it("does not match files in ignored-dir", async () => {
    // ignored-dir/secret.ts contains 'hello' but is gitignored
    const result = await grepTool.execute(
      { pattern: "hello", output_mode: "files_with_matches" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const lines = result.output.split("\n").filter(Boolean);
    expect(lines.every((l) => !l.includes("ignored-dir"))).toBe(true);
  });
});

describe("grep tool — head_limit", () => {
  it("caps output to head_limit lines", async () => {
    // pattern 'const' matches many lines; cap to 2
    const result = await grepTool.execute(
      { pattern: ".", head_limit: 2 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const lines = result.output.split("\n").filter(Boolean);
    // Claude Code's pagination note tells the model more matches exist.
    expect(lines[lines.length - 1]).toBe("[Showing results with pagination = limit: 2]");
    const contentLines = lines.slice(0, -1);
    expect(contentLines.length).toBeLessThanOrEqual(2);
  });

  it("supports -C context lines and -i case-insensitive flags", async () => {
    await writeFile(join(tmpDir, "context.txt"), "one\ntwo\nthree\n");
    const result = await grepTool.execute(
      { pattern: "TWO", "-i": true, "-C": 1, glob: "context.txt" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Match line uses `path:line:` separators; context lines use `path-line-`.
    expect(result.output).toMatch(/:2:two/);
    expect(result.output).toMatch(/-1-one/);
    expect(result.output).toMatch(/-3-three/);
  });
});
