/**
 * MemberSpec — declarative description of a team member.
 *
 * Used by TeamSession.spawnMember() / spawnAll() to construct a TaskPacket
 * + SpawnRequest under the hood. Stage 4A scope: minimal field set.
 * Full TeamSpec (with topology, coordination, completion rules) is
 * stage 4B; topology executors that consume them are stage 4E.
 */

import { z } from "zod";
import type {
  TaskBudget,
  BranchPolicy,
  CommitPolicy,
  EscalationPolicy,
} from "./host.js";

export interface MemberSpec {
  /** Stable id within the team; auto-generated when omitted. */
  readonly id?: string;
  /** Resolves via RoleRegistry to system-prompt suffix + allowedTools. */
  readonly role: string;
  /** The member's prompt. */
  readonly prompt: string;
  readonly budget?: TaskBudget;
  readonly branchPolicy?: BranchPolicy;
  readonly commitPolicy?: CommitPolicy;
  readonly escalationPolicy?: EscalationPolicy;
  readonly model?: string;
  /** V0.4.Q9 — mixed-engine consultant flag (deferred; placeholder). */
  readonly framework?: "claude-agent-sdk" | "codex-chatgpt";
}

/**
 * Zod schema for runtime validation (used by 4B's TeamSpec parser).
 * Don't import zod-shaped policy types from policies.ts directly — keep
 * this commit's surface narrow. Permissive `unknown` for nested policy
 * types here; full validation lives in stage 4B alongside the TeamSpec
 * schema.
 */
export const MemberSpecSchema = z.object({
  id: z.string().optional(),
  role: z.string().min(1),
  prompt: z.string().min(1),
  budget: z.unknown().optional(),
  branchPolicy: z.unknown().optional(),
  commitPolicy: z.unknown().optional(),
  escalationPolicy: z.unknown().optional(),
  model: z.string().optional(),
  framework: z.enum(["claude-agent-sdk", "codex-chatgpt"]).optional(),
}) satisfies z.ZodType<unknown>;
