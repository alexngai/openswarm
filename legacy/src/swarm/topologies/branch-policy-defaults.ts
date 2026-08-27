/**
 * branch-policy-defaults.ts — v0.7 stage 7D.
 *
 * Per-topology default branch policy resolution. Per docs/25 §10.4 table,
 * each topology has a sensible default `branchPolicy` to apply when:
 *   - the host's branch-policy adapter is stream-aware (git-cascade), AND
 *   - neither member.branchPolicy nor coordination.defaultBranchPolicy is set
 *
 * Topology executors call `applyDefaultBranchPolicy(spec, fallback)` before
 * spawning so each member gets its own worktree by default. Spec-level
 * overrides (member or coordination) always win.
 */
import type { TeamSpec, MemberSpec } from "../team-spec.js";
import type { BranchPolicy } from "../host.js";

/**
 * Return a TeamSpec where members without an explicit branchPolicy receive
 * `fallback`. Spec-level `coordination.defaultBranchPolicy` takes priority
 * over `fallback` (caller-provided per-topology default).
 *
 * No-op when neither override is needed: returns the original spec
 * reference (referential equality preserved for downstream identity checks).
 */
export function applyDefaultBranchPolicy(
  spec: TeamSpec,
  fallback: BranchPolicy,
): TeamSpec {
  const effective = spec.coordination.defaultBranchPolicy ?? fallback;
  // Skip work if every member already has an explicit policy.
  const needsRewrite = spec.members.some((m) => m.branchPolicy === undefined);
  if (!needsRewrite) return spec;
  const members: MemberSpec[] = spec.members.map((m) =>
    m.branchPolicy === undefined ? { ...m, branchPolicy: effective } : m,
  );
  return { ...spec, members };
}
