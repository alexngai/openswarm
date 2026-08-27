/**
 * Tests for the session scratchpad directory (Claude Code parity).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureScratchpadDir,
  formatScratchpadForSystemPrompt,
  resolveScratchpadDir,
  resolveWorkerScratchpadDir,
  SCRATCHPAD_BASE_ENV_VAR,
  SCRATCHPAD_ENV_VAR,
} from "./scratchpad.js";

const CWD = "/workspace/project";
const SESSION = "11111111-2222-3333-4444-555555555555";

let savedExact: string | undefined;
let savedBase: string | undefined;

beforeEach(() => {
  savedExact = process.env[SCRATCHPAD_ENV_VAR];
  savedBase = process.env[SCRATCHPAD_BASE_ENV_VAR];
  delete process.env[SCRATCHPAD_ENV_VAR];
  delete process.env[SCRATCHPAD_BASE_ENV_VAR];
});

afterEach(() => {
  if (savedExact !== undefined) process.env[SCRATCHPAD_ENV_VAR] = savedExact;
  else delete process.env[SCRATCHPAD_ENV_VAR];
  if (savedBase !== undefined) process.env[SCRATCHPAD_BASE_ENV_VAR] = savedBase;
  else delete process.env[SCRATCHPAD_BASE_ENV_VAR];
});

describe("resolveScratchpadDir", () => {
  it("defaults to os.tmpdir()/openswarm-<uid>/<cwd-slug>/<session>/scratchpad", () => {
    const dir = resolveScratchpadDir(CWD, SESSION);
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    expect(dir).toContain("openswarm-");
    expect(dir).toContain("-workspace-project");
    expect(dir).toContain(SESSION);
    expect(dir.endsWith(`${path.sep}scratchpad`)).toBe(true);
  });

  it("honors the base-dir override", () => {
    process.env[SCRATCHPAD_BASE_ENV_VAR] = "/persistent/scratch";
    const dir = resolveScratchpadDir(CWD, SESSION);
    expect(dir).toBe(
      path.join("/persistent/scratch", "-workspace-project", SESSION, "scratchpad"),
    );
  });

  it("honors the exact-dir override over the base-dir override", () => {
    process.env[SCRATCHPAD_ENV_VAR] = "/exact/dir";
    process.env[SCRATCHPAD_BASE_ENV_VAR] = "/persistent/scratch";
    expect(resolveScratchpadDir(CWD, SESSION)).toBe("/exact/dir");
  });

  it("sanitizes unsafe session-id characters", () => {
    const dir = resolveScratchpadDir(CWD, "weird id/../x");
    expect(dir).not.toContain("..");
    expect(dir).toContain("weird-id---x");
  });
});

describe("resolveWorkerScratchpadDir", () => {
  it("carves a per-agent subdir under an inherited session root", () => {
    process.env[SCRATCHPAD_ENV_VAR] = "/session/root/scratchpad";
    expect(resolveWorkerScratchpadDir(CWD, "agent-1")).toBe(
      path.join("/session/root/scratchpad", "agents", "agent-1"),
    );
  });

  it("allocates a fresh session dir keyed by agent id when standalone", () => {
    const dir = resolveWorkerScratchpadDir(CWD, "agent-1");
    expect(dir).toContain("agent-1");
    expect(dir.endsWith(`${path.sep}scratchpad`)).toBe(true);
  });
});

describe("ensureScratchpadDir", () => {
  it("creates the directory recursively with owner-only permissions", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "scratchpad-test-"));
    try {
      const target = path.join(base, "a", "b", "scratchpad");
      expect(ensureScratchpadDir(target)).toBe(target);
      const stat = fs.statSync(target);
      expect(stat.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
      // Idempotent.
      expect(ensureScratchpadDir(target)).toBe(target);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("formatScratchpadForSystemPrompt", () => {
  it("names the directory and steers away from /tmp", () => {
    const text = formatScratchpadForSystemPrompt("/some/dir");
    expect(text).toContain("## Scratchpad directory");
    expect(text).toContain("/some/dir");
    expect(text).toMatch(/instead of\s+\/tmp/);
  });
});
