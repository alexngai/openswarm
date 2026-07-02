/**
 * worktree.test.ts — `worktree list|clean` (v0.7 stage 7D).
 *
 * Tests stub `git worktree` calls via a fake gitBin so the suite doesn't
 * mutate real git state. Real-git smoke verification lives in the
 * integration script (7D follow-up if needed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { worktreeMain } from "./worktree.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "wt-cli-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureWriter(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => lines.push(s) };
}

describe("worktree list", () => {
  it("reports '(no worktrees …)' when the dir is missing", async () => {
    const cap = captureWriter();
    const code = await worktreeMain(["list", "--repo", tmp], { write: cap.write });
    expect(code).toBe(0);
    expect(cap.lines.join("")).toMatch(/no worktrees under /);
  });

  it("lists each subdirectory under .openswarm/worktrees/", async () => {
    const root = path.join(tmp, ".openswarm", "worktrees");
    await mkdir(path.join(root, "s-1"), { recursive: true });
    await mkdir(path.join(root, "s-2"), { recursive: true });
    // a stray file should be ignored
    await writeFile(path.join(root, "stray.txt"), "x");

    const cap = captureWriter();
    const code = await worktreeMain(["list", "--repo", tmp], { write: cap.write });
    expect(code).toBe(0);
    const out = cap.lines.join("");
    expect(out).toContain(path.join(root, "s-1"));
    expect(out).toContain(path.join(root, "s-2"));
    expect(out).not.toContain("stray.txt");
  });

  it("emits a JSON array with --json", async () => {
    await mkdir(path.join(tmp, ".openswarm", "worktrees", "s-1"), {
      recursive: true,
    });
    const cap = captureWriter();
    const code = await worktreeMain(["list", "--repo", tmp, "--json"], {
      write: cap.write,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("").trim()) as string[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatch(/s-1$/);
  });
});

describe("worktree clean", () => {
  it("--dry-run prints would-remove lines and does not invoke git", async () => {
    await mkdir(path.join(tmp, ".openswarm", "worktrees", "s-1"), {
      recursive: true,
    });
    const cap = captureWriter();
    // gitBin: a non-existent binary — if invoked, spawnSync would surface an error.
    const code = await worktreeMain(
      ["clean", "--repo", tmp, "--dry-run"],
      { write: cap.write, gitBin: "/nonexistent/git" },
    );
    expect(code).toBe(0);
    expect(cap.lines.join("")).toMatch(/would remove: .*s-1/);
    expect(cap.lines.join("")).not.toMatch(/removed:/);
  });

  it("returns 0 with '(no worktrees to clean)' when none exist", async () => {
    const cap = captureWriter();
    const code = await worktreeMain(["clean", "--repo", tmp], {
      write: cap.write,
      gitBin: "/nonexistent/git",
    });
    expect(code).toBe(0);
    expect(cap.lines.join("")).toMatch(/no worktrees to clean/);
  });

  it("invokes `git worktree remove --force <path>` for each worktree (real-git skipped — uses /bin/true)", async () => {
    await mkdir(path.join(tmp, ".openswarm", "worktrees", "s-1"), {
      recursive: true,
    });
    await mkdir(path.join(tmp, ".openswarm", "worktrees", "s-2"), {
      recursive: true,
    });
    const cap = captureWriter();
    // Use /usr/bin/true (or /bin/true) as a stand-in: returns 0 for any args,
    // which simulates a successful git invocation.
    const code = await worktreeMain(["clean", "--repo", tmp], {
      write: cap.write,
      gitBin: "/usr/bin/true",
    });
    expect(code).toBe(0);
    const out = cap.lines.join("");
    expect(out).toMatch(/removed: .*s-1/);
    expect(out).toMatch(/removed: .*s-2/);
    expect(out).toMatch(/summary: removed=2 failed=0/);
  });

  it("returns 1 and reports failures when git exits non-zero", async () => {
    await mkdir(path.join(tmp, ".openswarm", "worktrees", "s-1"), {
      recursive: true,
    });
    const cap = captureWriter();
    // /usr/bin/false always exits 1.
    const code = await worktreeMain(["clean", "--repo", tmp], {
      write: cap.write,
      gitBin: "/usr/bin/false",
    });
    expect(code).toBe(1);
    expect(cap.lines.join("")).toMatch(/FAILED: .*s-1/);
    expect(cap.lines.join("")).toMatch(/failed=1/);
  });
});

describe("worktree help / unknown", () => {
  it("returns 1 and prints usage when no subcommand", async () => {
    const cap = captureWriter();
    const code = await worktreeMain([], { write: cap.write });
    expect(code).toBe(1);
    expect(cap.lines.join("")).toMatch(/Usage:/);
  });

  it("returns 0 for `help`", async () => {
    const cap = captureWriter();
    const code = await worktreeMain(["help"], { write: cap.write });
    expect(code).toBe(0);
    expect(cap.lines.join("")).toMatch(/Usage:/);
  });

  it("rejects unknown subcommands", async () => {
    const cap = captureWriter();
    const code = await worktreeMain(["bogus"], { write: cap.write });
    expect(code).toBe(1);
    expect(cap.lines.join("")).toMatch(/unknown worktree subcommand: bogus/);
  });
});
