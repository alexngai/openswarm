/**
 * policies.test.ts — unit tests for Zod policy discriminated-union schemas.
 * Covers Phase 2.5: ≥ 10 cases per spec.
 */

import { describe, it, expect } from "vitest";
import {
  BranchPolicySchema,
  CommitPolicySchema,
  EscalationPolicySchema,
  TaskPacketSchema,
  isPolicyParseError,
} from "./policies.js";

// ---------------------------------------------------------------------------
// BranchPolicy
// ---------------------------------------------------------------------------

describe("BranchPolicySchema", () => {
  it("accepts kind=none", () => {
    expect(BranchPolicySchema.safeParse({ kind: "none" }).success).toBe(true);
  });

  it("accepts kind=reuse with branch", () => {
    const r = BranchPolicySchema.safeParse({ kind: "reuse", branch: "main" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ kind: "reuse", branch: "main" });
  });

  it("rejects kind=reuse with empty branch", () => {
    const r = BranchPolicySchema.safeParse({ kind: "reuse", branch: "" });
    expect(r.success).toBe(false);
  });

  it("rejects kind=reuse with missing branch", () => {
    const r = BranchPolicySchema.safeParse({ kind: "reuse" });
    expect(r.success).toBe(false);
  });

  it("accepts kind=create with from", () => {
    const r = BranchPolicySchema.safeParse({ kind: "create", from: "main" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ kind: "create", from: "main" });
  });

  it("accepts kind=create with from and optional name", () => {
    const r = BranchPolicySchema.safeParse({ kind: "create", from: "main", name: "feat/x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ kind: "create", from: "main", name: "feat/x" });
  });

  it("rejects kind=create with missing from", () => {
    const r = BranchPolicySchema.safeParse({ kind: "create" });
    expect(r.success).toBe(false);
  });

  // v0.7 stage 7A.1 — git-cascade variants
  it("accepts kind=stream with no fields (fresh stream from HEAD)", () => {
    const r = BranchPolicySchema.safeParse({ kind: "stream" });
    expect(r.success).toBe(true);
  });

  it("accepts kind=stream with baseStreamId + name", () => {
    const r = BranchPolicySchema.safeParse({
      kind: "stream",
      baseStreamId: "s-abc",
      name: "feature/x",
    });
    expect(r.success).toBe(true);
  });

  it("rejects kind=stream with empty baseStreamId", () => {
    const r = BranchPolicySchema.safeParse({
      kind: "stream",
      baseStreamId: "",
    });
    expect(r.success).toBe(false);
  });

  it("accepts kind=fork with parentStreamId", () => {
    const r = BranchPolicySchema.safeParse({
      kind: "fork",
      parentStreamId: "s-parent",
    });
    expect(r.success).toBe(true);
  });

  it("rejects kind=fork without parentStreamId", () => {
    const r = BranchPolicySchema.safeParse({ kind: "fork" });
    expect(r.success).toBe(false);
  });

  it("rejects legacy flat string 'main'", () => {
    const r = BranchPolicySchema.safeParse("main");
    expect(r.success).toBe(false);
    if (!r.success) {
      // Zod error must mention the failure clearly
      expect(r.error.message.length).toBeGreaterThan(0);
    }
  });

  it("rejects legacy flat string 'worktree'", () => {
    expect(BranchPolicySchema.safeParse("worktree").success).toBe(false);
  });

  it("rejects unknown kind value", () => {
    const r = BranchPolicySchema.safeParse({ kind: "detach" });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Zod discriminated union surfaces "Invalid input" for unrecognized discriminator.
      expect(r.error.issues.length).toBeGreaterThan(0);
      // The first issue should be about the discriminator field.
      const issue = r.error.issues[0]!;
      expect(["invalid_union", "invalid_union_discriminator", "invalid_literal"]).toContain(issue.code);
    }
  });
});

// ---------------------------------------------------------------------------
// CommitPolicy
// ---------------------------------------------------------------------------

describe("CommitPolicySchema", () => {
  it("accepts kind=none", () => {
    expect(CommitPolicySchema.safeParse({ kind: "none" }).success).toBe(true);
  });

  it("accepts kind=auto without message", () => {
    expect(CommitPolicySchema.safeParse({ kind: "auto" }).success).toBe(true);
  });

  it("accepts kind=auto with message", () => {
    const r = CommitPolicySchema.safeParse({ kind: "auto", message: "feat: add x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ kind: "auto", message: "feat: add x" });
  });

  it("accepts kind=atomic", () => {
    expect(CommitPolicySchema.safeParse({ kind: "atomic" }).success).toBe(true);
  });

  it("rejects legacy flat string 'never'", () => {
    expect(CommitPolicySchema.safeParse("never").success).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(CommitPolicySchema.safeParse({ kind: "on-success" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EscalationPolicy
// ---------------------------------------------------------------------------

describe("EscalationPolicySchema", () => {
  it("accepts kind=none", () => {
    expect(EscalationPolicySchema.safeParse({ kind: "none" }).success).toBe(true);
  });

  it("accepts kind=retry with max and backoff=fixed", () => {
    const r = EscalationPolicySchema.safeParse({ kind: "retry", max: 3, backoff: "fixed" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ kind: "retry", max: 3, backoff: "fixed" });
  });

  it("accepts kind=retry with backoff=exponential", () => {
    const r = EscalationPolicySchema.safeParse({ kind: "retry", max: 5, backoff: "exponential" });
    expect(r.success).toBe(true);
  });

  it("rejects kind=retry with missing max", () => {
    const r = EscalationPolicySchema.safeParse({ kind: "retry", backoff: "fixed" });
    expect(r.success).toBe(false);
  });

  it("rejects kind=retry with invalid backoff value", () => {
    const r = EscalationPolicySchema.safeParse({ kind: "retry", max: 3, backoff: "linear" });
    expect(r.success).toBe(false);
  });

  it("accepts kind=handoff with targetRole", () => {
    const r = EscalationPolicySchema.safeParse({ kind: "handoff", targetRole: "reviewer" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ kind: "handoff", targetRole: "reviewer" });
  });

  it("rejects kind=handoff with empty targetRole", () => {
    expect(EscalationPolicySchema.safeParse({ kind: "handoff", targetRole: "" }).success).toBe(false);
  });

  it("rejects legacy flat string 'abort-on-error'", () => {
    expect(EscalationPolicySchema.safeParse("abort-on-error").success).toBe(false);
  });

  it("rejects legacy flat string 'retry-with-backoff'", () => {
    expect(EscalationPolicySchema.safeParse("retry-with-backoff").success).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(EscalationPolicySchema.safeParse({ kind: "ask-user" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TaskPacket composite
// ---------------------------------------------------------------------------

describe("TaskPacketSchema", () => {
  const validPacket = {
    id: "task-1",
    prompt: "do the thing",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
  };

  it("accepts a full valid packet with all three union policies", () => {
    expect(TaskPacketSchema.safeParse(validPacket).success).toBe(true);
  });

  it("accepts packet with retry escalation and budget", () => {
    const r = TaskPacketSchema.safeParse({
      ...validPacket,
      escalationPolicy: { kind: "retry", max: 3, backoff: "exponential" },
      budget: { maxTurns: 10, maxWallClockMs: 60000, maxWallClockMsPerAttempt: 20000 },
    });
    expect(r.success).toBe(true);
  });

  it("accepts packet with reuse branch and context", () => {
    const r = TaskPacketSchema.safeParse({
      ...validPacket,
      branchPolicy: { kind: "reuse", branch: "feature/x" },
      context: { files: ["src/foo.ts"], parentTaskId: "parent-1" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts packet with role field", () => {
    const r = TaskPacketSchema.safeParse({ ...validPacket, role: "executor" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.role).toBe("executor");
  });

  it("rejects packet with legacy flat-string branchPolicy", () => {
    const r = TaskPacketSchema.safeParse({ ...validPacket, branchPolicy: "main" });
    expect(r.success).toBe(false);
  });

  it("rejects packet with legacy flat-string commitPolicy", () => {
    const r = TaskPacketSchema.safeParse({ ...validPacket, commitPolicy: "never" });
    expect(r.success).toBe(false);
  });

  it("rejects packet with legacy flat-string escalationPolicy", () => {
    const r = TaskPacketSchema.safeParse({ ...validPacket, escalationPolicy: "abort-on-error" });
    expect(r.success).toBe(false);
  });

  it("rejects packet missing prompt", () => {
    const { prompt: _p, ...noPrompt } = validPacket;
    expect(TaskPacketSchema.safeParse(noPrompt).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPolicyParseError helper
// ---------------------------------------------------------------------------

describe("isPolicyParseError", () => {
  it("returns true when message mentions branchPolicy", () => {
    expect(isPolicyParseError("Invalid value for branchPolicy")).toBe(true);
  });

  it("returns true when message mentions commitPolicy", () => {
    expect(isPolicyParseError("commitPolicy: expected object")).toBe(true);
  });

  it("returns true when message mentions escalationPolicy", () => {
    expect(isPolicyParseError("escalationPolicy is invalid")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPolicyParseError("prompt is required")).toBe(false);
  });
});
