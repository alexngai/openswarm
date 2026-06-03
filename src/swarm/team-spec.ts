/**
 * MemberSpec / TeamSpec — declarative description of a team and its members.
 *
 * Stage 4A scope: minimal MemberSpec used by TeamSession.spawnMember() /
 * spawnAll() to construct a TaskPacket + SpawnRequest under the hood.
 *
 * Stage 4B scope (this file): full TeamSpec — TopologyKind, CompletionRule,
 * Aggregator, TeamCommunicationRules, TeamCoordination, TeamSpec — plus zod
 * schemas with strict validation. Topology executors that consume them are
 * stage 4E (the `Aggregator.custom.fn` callback is intentionally omitted from
 * the schema; it's passed at runtime by code-driven topology constructors).
 *
 * `defaultBranchPolicy` is typed as `BranchPolicy` for ergonomics but the
 * schema validates it as `z.unknown()` — full BranchPolicy validation inside
 * a TeamSpec lands in stage 4E (when topology executors actually use it),
 * keeping this commit's surface narrow and free of cross-module schema
 * dependencies.
 */

import { z } from "zod";
import type {
  TaskBudget,
  BranchPolicy,
  CommitPolicy,
  EscalationPolicy,
} from "./host.js";

// ---------------------------------------------------------------------------
// MemberSpec
// ---------------------------------------------------------------------------

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
  /**
   * V0.4 stage 4E.4 — opt this member into long-lived worker mode.
   *
   * When true, TeamSession.spawnMember forwards
   * `SpawnRequest.longLived: true` so the worker stays alive across
   * multiple `task_result` boundaries. CoordinatorTopology uses this for
   * its root member, which spawns peers via the `agent` tool across
   * many turns. Default: false (worker exits after first task_result).
   */
  readonly longLived?: boolean;
  /**
   * Working directory for the member's worker. Overrides the orchestrator's
   * cwd; threaded to `SpawnRequest.cwd`. The ACP team path uses this to honor
   * the client's `session/new` cwd (the editor's project root). When unset, the
   * spawner falls back to `process.cwd()`.
   */
  readonly cwd?: string;
}

/**
 * Zod schema for runtime validation. Permissive `unknown` for nested policy
 * types here; full strict validation lives in stage 4E alongside topology
 * executors. The schema accepts the shapes documented in docs/25 §5.
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
  longLived: z.boolean().optional(),
  cwd: z.string().optional(),
}) satisfies z.ZodType<unknown>;

// ---------------------------------------------------------------------------
// TopologyKind
// ---------------------------------------------------------------------------

export type TopologyKind =
  | "fanout"
  | "pipeline"
  | "coordinator"
  | "peer-team"
  | "committee"
  | "critic-loop";

export const TopologyKindSchema = z.enum([
  "fanout",
  "pipeline",
  "coordinator",
  "peer-team",
  "committee",
  "critic-loop",
]);

// ---------------------------------------------------------------------------
// CompletionRule
// ---------------------------------------------------------------------------

export type CompletionRule =
  | { readonly kind: "all" }
  | { readonly kind: "any" }
  | { readonly kind: "majority"; readonly m: number }
  | { readonly kind: "deadline"; readonly ms: number }
  | { readonly kind: "until_signal"; readonly signal: string };

export const CompletionRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("any") }),
  z.object({ kind: z.literal("majority"), m: z.number().int().positive() }),
  z.object({ kind: z.literal("deadline"), ms: z.number().int().positive() }),
  z.object({ kind: z.literal("until_signal"), signal: z.string().min(1) }),
]);

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * `custom.fn` callback omitted from the schema; passed at runtime by
 * code-driven topology constructors. The schema only admits the discriminator.
 */
export type Aggregator =
  | { readonly kind: "concat"; readonly separator?: string }
  | { readonly kind: "last" }
  | { readonly kind: "vote" }
  | { readonly kind: "judge"; readonly role: string }
  | { readonly kind: "custom" };

export const AggregatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("concat"), separator: z.string().optional() }),
  z.object({ kind: z.literal("last") }),
  z.object({ kind: z.literal("vote") }),
  z.object({ kind: z.literal("judge"), role: z.string().min(1) }),
  z.object({ kind: z.literal("custom") }),
]);

// ---------------------------------------------------------------------------
// TeamCommunicationRules
// ---------------------------------------------------------------------------

/**
 * Placeholder for the openteams `communication` block. Full materialization
 * (signal vocabulary, channel routing) is stage 4F's job; here we just admit
 * the shape so TeamSpec round-trips through JSON cleanly.
 */
export interface TeamCommunicationRules {
  readonly enforcement?: "permissive" | "strict";
  readonly channels?: Record<string, { readonly signals: readonly string[] }>;
  readonly subscriptions?: Record<string, readonly { readonly channel: string }[]>;
  readonly emissions?: Record<string, readonly string[]>;
}

export const TeamCommunicationRulesSchema = z.object({
  enforcement: z.enum(["permissive", "strict"]).optional(),
  channels: z
    .record(z.string(), z.object({ signals: z.array(z.string()) }))
    .optional(),
  subscriptions: z
    .record(z.string(), z.array(z.object({ channel: z.string() })))
    .optional(),
  emissions: z.record(z.string(), z.array(z.string())).optional(),
});

// ---------------------------------------------------------------------------
// TeamCoordination
// ---------------------------------------------------------------------------

export interface TeamCoordination {
  readonly completion: CompletionRule;
  readonly aggregator?: Aggregator;
  readonly aggregateBudget?: {
    readonly maxTokens?: number;
    readonly maxCostUsd?: number;
  };
  readonly defaultBranchPolicy?: BranchPolicy;
  readonly communication?: TeamCommunicationRules;
  /** V0.4.Q5 — long-lived worker idle timeout. Default 600_000 (10 min). */
  readonly idleTimeoutMs?: number;
  /** V0.4.Q7 — explicit shared MAP scope override. */
  readonly mapScope?: string;
  /** V0.4.Q4 — `team send` routing entry point. */
  readonly entryPoint?: "root" | "broadcast" | { readonly role: string };
  /**
   * V0.7 stage 7C — auto-merge member streams into a target stream when
   * the team completes successfully. Requires a stream-aware
   * BranchPolicyAdapter (e.g. GitCascadeBranchPolicyAdapter); ignored
   * with the identity adapter.
   *
   * Specify exactly one of `targetStream` (existing streamId) or
   * `targetBranch` (git branch name; v0.7 stage 7F — adapter auto-
   * creates a worktree-less integrator stream tracking that branch).
   * targetBranch is the typical "merge into main" path.
   */
  readonly mergeStreams?: {
    readonly targetStream?: string;
    readonly targetBranch?: string;
    readonly strategy?: string;
    /** When true, a merge conflict surfaces as a topology failure. Default false. */
    readonly failOnConflict?: boolean;
  };
}

export const TeamCoordinationSchema = z.object({
  completion: CompletionRuleSchema,
  aggregator: AggregatorSchema.optional(),
  aggregateBudget: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
    })
    .optional(),
  // BranchPolicySchema lives in policies.ts; full validation lands in 4E.
  defaultBranchPolicy: z.unknown().optional(),
  communication: TeamCommunicationRulesSchema.optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  mapScope: z.string().min(1).optional(),
  entryPoint: z
    .union([
      z.enum(["root", "broadcast"]),
      z.object({ role: z.string().min(1) }),
    ])
    .optional(),
  mergeStreams: z
    .object({
      targetStream: z.string().min(1).optional(),
      targetBranch: z.string().min(1).optional(),
      strategy: z.string().optional(),
      failOnConflict: z.boolean().optional(),
    })
    .refine(
      (v) => (v.targetStream !== undefined) !== (v.targetBranch !== undefined),
      { message: "mergeStreams: exactly one of targetStream or targetBranch must be set" },
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// TeamSpec
// ---------------------------------------------------------------------------

export interface TeamSpec {
  readonly name: string;
  readonly topology: TopologyKind;
  readonly members: readonly MemberSpec[];
  readonly coordination: TeamCoordination;
  /** Optional: openteams template name when this spec was loaded from one. */
  readonly templateName?: string;
}

export const TeamSpecSchema = z.object({
  name: z.string().min(1),
  topology: TopologyKindSchema,
  members: z.array(MemberSpecSchema).min(1),
  coordination: TeamCoordinationSchema,
  templateName: z.string().min(1).optional(),
}) satisfies z.ZodType<unknown>;
