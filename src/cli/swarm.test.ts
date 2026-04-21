/**
 * swarm.test.ts — tests for runSwarm CLI entry point.
 *
 * Covers:
 * - Migration hint emitted to stderr on legacy flat-string policy input.
 * - No hint emitted for non-policy validation errors.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We test runSwarm by writing temp files and capturing stderr.
// To avoid spawning real workers, we need to inject a mock orchestrator.
// The simplest approach: test the policy parse layer directly via the
// taskPacketSchema + isPolicyParseError logic that swarm.ts uses.
// For the migration hint test, we call runSwarm with a legacy tasks.jsonl
// and capture process.stderr output.

import { isPolicyParseError } from "../swarm/policies.js";
import { TaskPacketSchema } from "../swarm/policies.js";
import { z } from "zod";

// Extend to match what swarm.ts uses (optional id).
const taskPacketSchema = TaskPacketSchema.extend({ id: z.string().optional() });

// ---------------------------------------------------------------------------
// Unit tests for the policy schema used by swarm.ts
// ---------------------------------------------------------------------------

describe("swarm.ts policy parse layer", () => {
  it("rejects legacy branchPolicy flat string and isPolicyParseError returns true", () => {
    const result = taskPacketSchema.safeParse({
      id: "t1",
      prompt: "hello",
      branchPolicy: "main",
      commitPolicy: { kind: "none" },
      escalationPolicy: { kind: "none" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isPolicyParseError(result.error.message)).toBe(true);
    }
  });

  it("rejects legacy commitPolicy flat string and isPolicyParseError returns true", () => {
    const result = taskPacketSchema.safeParse({
      id: "t1",
      prompt: "hello",
      branchPolicy: { kind: "none" },
      commitPolicy: "never",
      escalationPolicy: { kind: "none" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isPolicyParseError(result.error.message)).toBe(true);
    }
  });

  it("rejects legacy escalationPolicy flat string and isPolicyParseError returns true", () => {
    const result = taskPacketSchema.safeParse({
      id: "t1",
      prompt: "hello",
      branchPolicy: { kind: "none" },
      commitPolicy: { kind: "none" },
      escalationPolicy: "abort-on-error",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isPolicyParseError(result.error.message)).toBe(true);
    }
  });

  it("does NOT flag isPolicyParseError for a missing prompt error", () => {
    const result = taskPacketSchema.safeParse({
      id: "t1",
      // prompt missing
      branchPolicy: { kind: "none" },
      commitPolicy: { kind: "none" },
      escalationPolicy: { kind: "none" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isPolicyParseError(result.error.message)).toBe(false);
    }
  });

  it("accepts valid discriminated union packet with optional id", () => {
    const result = taskPacketSchema.safeParse({
      prompt: "hello",
      branchPolicy: { kind: "none" },
      commitPolicy: { kind: "auto" },
      escalationPolicy: { kind: "retry", max: 3, backoff: "exponential" },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: runSwarm emits migration hint to stderr on legacy input
// ---------------------------------------------------------------------------

describe("runSwarm migration hint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits migration hint to stderr when tasks.jsonl has legacy flat-string policy", async () => {
    // Write a temp tasks.jsonl with legacy flat-string policies.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-"));
    const tasksFile = path.join(tmpDir, "tasks.jsonl");
    const resultsFile = path.join(tmpDir, "results.jsonl");
    fs.writeFileSync(
      tasksFile,
      JSON.stringify({
        id: "t1",
        prompt: "hello",
        branchPolicy: "main",
        commitPolicy: "never",
        escalationPolicy: "abort-on-error",
      }) + "\n",
    );

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrLines.push(String(chunk));
        return true;
      });

    const { runSwarm } = await import("./swarm.js");
    const exitCode = await runSwarm({
      tasksFile,
      concurrency: 1,
      output: resultsFile,
      permissionMode: "workspace-write",
    });

    expect(exitCode).toBe(2);
    const combined = stderrLines.join("");
    expect(combined).toContain(
      "[swarm-coder] TaskPacket policies are now discriminated unions — see docs/11-m3a-plan.md §Policy migration",
    );

    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT emit migration hint for a missing-prompt parse error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-"));
    const tasksFile = path.join(tmpDir, "tasks.jsonl");
    const resultsFile = path.join(tmpDir, "results.jsonl");
    fs.writeFileSync(
      tasksFile,
      JSON.stringify({
        id: "t1",
        // prompt missing
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
      }) + "\n",
    );

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrLines.push(String(chunk));
        return true;
      });

    const { runSwarm } = await import("./swarm.js");
    const exitCode = await runSwarm({
      tasksFile,
      concurrency: 1,
      output: resultsFile,
      permissionMode: "workspace-write",
    });

    expect(exitCode).toBe(2);
    const combined = stderrLines.join("");
    expect(combined).not.toContain("§Policy migration");

    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
