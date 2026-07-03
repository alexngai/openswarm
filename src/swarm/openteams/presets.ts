/**
 * presets.ts — built-in team presets shipped with openswarm.
 *
 * Goal: let a user run `openswarm team start <preset>` (e.g. `review`, `fix`,
 * `refactor`) WITHOUT authoring or pointing at a local OpenTeams `.yaml`
 * template. A bare preset name resolves to one of the bundled {@link TeamSpec}
 * objects defined here.
 *
 * These are in-code TeamSpec objects rather than bundled YAML: they need no
 * `openteams generate` shell-out, they are validated by the same
 * {@link TeamSpecSchema} that `topology` specs use, and defining them in TS
 * gives full control over per-member prompts/roles (which the OpenteamsConfig →
 * TeamSpec mapping keys by role name and so can't express two members sharing
 * one role with distinct prompts).
 *
 * Member `role`s intentionally use the read-only / read-mostly built-ins from
 * `../roles.ts` (`reviewer` is read-only; `executor` has write tools) so the
 * presets get the right tool overlays out of the box:
 *   - review    → two read-only `reviewer`s (parallel, independent reviews).
 *   - fix       → `executor` (diagnose + patch) then `reviewer` (verify).
 *   - refactor  → `executor` (scoped refactor) then `reviewer` (review).
 *
 * PRECEDENCE: a project-local template with the same name wins over a built-in
 * preset. The precedence check lives in `../../cli/team.ts` (it needs cwd + fs);
 * this module is a pure registry.
 */

import { TeamSpecSchema, type TeamSpec } from "../team-spec.js";

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

const REVIEW: TeamSpec = {
  name: "review",
  topology: "fanout",
  members: [
    {
      id: "reviewer",
      role: "reviewer",
      prompt:
        "You are the general reviewer. Review the diff / PR in the current " +
        "working tree (start from `git diff` / `git status`). Assess " +
        "correctness, readability, and maintainability; call out bugs, risky " +
        "edge cases, and concrete fixes. Do not modify files — produce a " +
        "written review only.",
    },
    {
      id: "security-reviewer",
      role: "reviewer",
      prompt:
        "You are the security & tests reviewer. Review the same diff / PR for " +
        "security issues (injection, auth, secrets, unsafe I/O) and test " +
        "coverage gaps. Flag missing or weak tests and any exploitable " +
        "patterns, with concrete remediations. Do not modify files — produce " +
        "a written review only.",
    },
  ],
  coordination: {
    completion: { kind: "all" },
    aggregator: { kind: "concat", separator: "\n\n---\n\n" },
  },
  templateName: "review",
};

const FIX: TeamSpec = {
  name: "fix",
  topology: "pipeline",
  members: [
    {
      id: "implementer",
      role: "executor",
      prompt:
        "You are the debugger/implementer. Diagnose the described bug, find " +
        "the root cause, and apply a minimal, focused fix. Prefer adding or " +
        "updating a regression test that fails before your change and passes " +
        "after.",
    },
    {
      id: "verifier",
      role: "reviewer",
      prompt:
        "You are the verifier. Confirm the fix actually resolves the reported " +
        "bug: read the change, reason about edge cases, and run/inspect the " +
        "relevant tests. Report whether the bug is resolved and flag any " +
        "regressions. Do not modify files.",
    },
  ],
  coordination: {
    completion: { kind: "all" },
  },
  templateName: "fix",
};

const REFACTOR: TeamSpec = {
  name: "refactor",
  topology: "pipeline",
  members: [
    {
      id: "implementer",
      role: "executor",
      prompt:
        "You are the refactoring implementer. Perform the scoped refactor " +
        "described in the prompt WITHOUT changing observable behavior. Keep " +
        "the change focused; do not mix in unrelated edits. Ensure the build " +
        "and existing tests still pass.",
    },
    {
      id: "reviewer",
      role: "reviewer",
      prompt:
        "You are the reviewer. Verify the refactor preserves behavior and " +
        "actually improves clarity/structure. Check that no functionality was " +
        "dropped and that tests still cover the touched code. Do not modify " +
        "files — produce a written review only.",
    },
  ],
  coordination: {
    completion: { kind: "all" },
  },
  templateName: "refactor",
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All built-in presets, keyed by the name a user types after `team start`.
 * Frozen so callers can't mutate the shared spec (members/coordination are
 * handed straight to the orchestrator).
 */
export const BUILTIN_PRESETS: Readonly<Record<string, TeamSpec>> = Object.freeze(
  {
    review: REVIEW,
    fix: FIX,
    refactor: REFACTOR,
  },
);

/** Names of all built-in presets (stable, sorted for help output). */
export function presetNames(): readonly string[] {
  return Object.keys(BUILTIN_PRESETS).sort();
}

/** True when `name` matches a built-in preset. */
export function isPresetName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESETS, name);
}

/**
 * Look up a built-in preset by name. Returns the parsed+validated
 * {@link TeamSpec} (validated via {@link TeamSpecSchema} so a malformed preset
 * fails loudly here rather than deep in the orchestrator), or `undefined` when
 * no preset matches.
 */
export function getPreset(name: string): TeamSpec | undefined {
  const raw = BUILTIN_PRESETS[name];
  if (raw === undefined) return undefined;
  const parsed = TeamSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `built-in preset "${name}" is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data as TeamSpec;
}
