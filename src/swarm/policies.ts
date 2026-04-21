/**
 * policies.ts — Zod schemas for TaskPacket policy discriminated unions.
 *
 * Replaces the legacy flat-string enums (M1/M2) with runtime-validated
 * discriminated unions. Import TaskPacketSchema in CLI entry points and
 * tools that accept raw user input.
 *
 * See docs/11-m3a-plan.md §Phase 2 and §Policy migration for before/after
 * migration examples.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Policy schemas
// ---------------------------------------------------------------------------

export const BranchPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("reuse"), branch: z.string().min(1) }),
  z.object({
    kind: z.literal("create"),
    from: z.string().min(1),
    name: z.string().optional(),
  }),
]);

export const CommitPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("auto"), message: z.string().optional() }),
  z.object({ kind: z.literal("atomic") }),
]);

export const EscalationPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("retry"),
    max: z.number().int().positive(),
    backoff: z.enum(["fixed", "exponential"]),
  }),
  z.object({
    kind: z.literal("handoff"),
    targetRole: z.string().min(1),
  }),
]);

// ---------------------------------------------------------------------------
// TaskPacket schema
// ---------------------------------------------------------------------------

export const TaskPacketSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  branchPolicy: BranchPolicySchema,
  commitPolicy: CommitPolicySchema,
  escalationPolicy: EscalationPolicySchema,
  budget: z
    .object({
      maxTurns: z.number().optional(),
      maxTokens: z.number().optional(),
      maxWallClockMs: z.number().optional(),
      maxWallClockMsPerAttempt: z.number().optional(),
    })
    .optional(),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      parentTaskId: z.string().optional(),
    })
    .optional(),
  role: z.string().optional(),
});

export type TaskPacketInput = z.infer<typeof TaskPacketSchema>;

// ---------------------------------------------------------------------------
// Policy field names used to detect migration-relevant parse failures
// ---------------------------------------------------------------------------

export const POLICY_FIELD_NAMES = ["branchPolicy", "commitPolicy", "escalationPolicy"] as const;

/**
 * Returns true when the Zod error mentions a policy field by name.
 * Used by the CLI to decide whether to emit the migration hint.
 */
export function isPolicyParseError(zodErrorMessage: string): boolean {
  return POLICY_FIELD_NAMES.some((field) => zodErrorMessage.includes(field));
}
