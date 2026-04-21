import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "swarm-coder-init-test-"));
}

async function cleanTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInit", () => {
  const tmps: string[] = [];

  afterEach(async () => {
    for (const d of tmps) {
      await cleanTmpDir(d);
    }
    tmps.length = 0;
  });

  it("creates .swarm-coder/ directory", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    const { runInit } = await import("./init.js");
    const code = await runInit(dir);

    expect(code).toBe(0);
    const stat = await fs.stat(path.join(dir, ".swarm-coder"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("adds .swarm-coder/ to .gitignore", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    const { runInit } = await import("./init.js");
    await runInit(dir);

    const gitignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".swarm-coder/");
  });

  it("does not duplicate .swarm-coder/ entry in .gitignore on second run", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    const { runInit } = await import("./init.js");
    await runInit(dir);
    await runInit(dir);

    const gitignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    const count = gitignore.split(".swarm-coder/").length - 1;
    expect(count).toBe(1);
  });

  it("creates CLAUDE.md with node flavor when package.json is present", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    // Write a package.json to trigger node detection.
    await fs.writeFile(path.join(dir, "package.json"), '{"name":"test"}', "utf8");

    const { runInit } = await import("./init.js");
    await runInit(dir);

    const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Node.js");
    expect(claude).toContain("npm");
  });

  it("creates CLAUDE.md with rust flavor when Cargo.toml is present", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    await fs.writeFile(path.join(dir, "Cargo.toml"), "[package]\nname = \"test\"", "utf8");

    const { runInit } = await import("./init.js");
    await runInit(dir);

    const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Rust");
    expect(claude).toContain("cargo");
  });

  it("creates CLAUDE.md with python flavor when pyproject.toml is present", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    await fs.writeFile(path.join(dir, "pyproject.toml"), "[tool.poetry]\nname = \"test\"", "utf8");

    const { runInit } = await import("./init.js");
    await runInit(dir);

    const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Python");
    expect(claude).toContain("pytest");
  });

  it("creates CLAUDE.md with generic flavor when no stack file is present", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    const { runInit } = await import("./init.js");
    await runInit(dir);

    const claude = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Generic");
  });

  it("does not overwrite existing CLAUDE.md on second run", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    const original = "# My custom CLAUDE.md\n";
    await fs.writeFile(path.join(dir, "CLAUDE.md"), original, "utf8");

    const { runInit } = await import("./init.js");
    await runInit(dir);

    const content = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(content).toBe(original);
  });

  it("is idempotent: returns 0 on repeated calls", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    const { runInit } = await import("./init.js");
    const code1 = await runInit(dir);
    const code2 = await runInit(dir);

    expect(code1).toBe(0);
    expect(code2).toBe(0);
  });

  it("appends .swarm-coder/ to existing .gitignore without removing existing entries", async () => {
    const dir = await makeTmpDir();
    tmps.push(dir);

    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\ndist/\n", "utf8");

    const { runInit } = await import("./init.js");
    await runInit(dir);

    const gitignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain(".swarm-coder/");
  });
});
