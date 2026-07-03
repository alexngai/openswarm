import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadProjectInstructions,
  formatInstructionsForSystemPrompt,
  formatInstructionsAsReminder,
  MAX_INSTRUCTION_FILE_CHARS,
} from "./project-instructions.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "proj-instr-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe("loadProjectInstructions", () => {
  it("returns no files when none exist", () => {
    const sub = path.join(root, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    expect(loadProjectInstructions(sub).files).toEqual([]);
  });

  it("walks ancestors root → cwd (deepest scope last)", () => {
    write("AGENTS.md", "ROOT rules");
    write("a/b/AGENTS.md", "DEEP rules");
    const cwd = path.join(root, "a", "b");

    const { files } = loadProjectInstructions(cwd);
    expect(files.map((f) => f.content)).toEqual(["ROOT rules", "DEEP rules"]);
    expect(files[0]!.path).toBe(path.join(root, "AGENTS.md"));
    expect(files[1]!.path).toBe(path.join(cwd, "AGENTS.md"));
  });

  it("orders filenames CLAUDE.md, CLAUDE.local.md, AGENTS.md within a level", () => {
    write("AGENTS.md", "agents");
    write("CLAUDE.md", "claude");
    write("CLAUDE.local.md", "local");

    const { files } = loadProjectInstructions(root);
    expect(files.map((f) => f.content)).toEqual(["claude", "local", "agents"]);
  });

  it("dedupes identical content across levels (keeps the first / root)", () => {
    write("AGENTS.md", "same content");
    write("sub/AGENTS.md", "same content");
    const { files } = loadProjectInstructions(path.join(root, "sub"));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(path.join(root, "AGENTS.md"));
  });

  it("clamps a single file to the per-file budget with a marker", () => {
    write("AGENTS.md", "x".repeat(MAX_INSTRUCTION_FILE_CHARS + 500));
    const { files } = loadProjectInstructions(root);
    expect(files[0]!.content.length).toBeLessThanOrEqual(
      MAX_INSTRUCTION_FILE_CHARS + "\n\n[truncated]".length,
    );
    expect(files[0]!.content.endsWith("[truncated]")).toBe(true);
  });

  it("stops after the total budget is exhausted", () => {
    write("AGENTS.md", "a".repeat(3000));
    write("a/AGENTS.md", "b".repeat(3000));
    write("a/b/AGENTS.md", "c".repeat(3000));
    write("a/b/c/AGENTS.md", "d".repeat(3000));
    write("a/b/c/d/AGENTS.md", "e".repeat(3000));
    const cwd = path.join(root, "a", "b", "c", "d");

    const { files } = loadProjectInstructions(cwd, { maxTotalChars: 8000 });
    const total = files.reduce((n, f) => n + f.content.length, 0);
    expect(total).toBeLessThanOrEqual(8000);
    // Not all five fit.
    expect(files.length).toBeLessThan(5);
  });

  it("skips empty and whitespace-only files", () => {
    write("AGENTS.md", "   \n\t\n");
    write("CLAUDE.md", "real");
    const { files } = loadProjectInstructions(root);
    expect(files.map((f) => f.content)).toEqual(["real"]);
  });
});

describe("formatInstructionsForSystemPrompt", () => {
  it("is empty when there are no files", () => {
    expect(formatInstructionsForSystemPrompt({ files: [] })).toBe("");
  });

  it("wraps each file in an instructions block under a heading", () => {
    write("AGENTS.md", "do the thing");
    const instr = loadProjectInstructions(root);
    const text = formatInstructionsForSystemPrompt(instr);
    expect(text).toContain("## Project instructions");
    expect(text).toContain(`<instructions path="${path.join(root, "AGENTS.md")}">`);
    expect(text).toContain("do the thing");
    expect(text).toContain("</instructions>");
  });
});

describe("formatInstructionsAsReminder", () => {
  it("is empty when there are no files", () => {
    expect(formatInstructionsAsReminder({ files: [] })).toBe("");
  });

  it("labels the re-attachment and includes the blocks", () => {
    write("CLAUDE.md", "keep this in mind");
    const instr = loadProjectInstructions(root);
    const text = formatInstructionsAsReminder(instr);
    expect(text).toContain("re-attached after compaction");
    expect(text).toContain("keep this in mind");
  });
});
