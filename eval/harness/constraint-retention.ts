/**
 * constraint-retention — measurement instrument for TE-25 (docs/55).
 *
 * Question: when a session is compacted, do durable user-stated constraints
 * survive into the summary so the resumed model still honors them? This is the
 * failure mode TE-25 targets — the byte-exact CC summary prompt preserves only
 * *security-relevant* constraints verbatim, so a non-security rule ("never
 * touch X", a chosen name/path/version, a library decision) can be folded away.
 *
 * This module is the pure, deterministic half: fixtures that seed a constraint
 * early in a session, and a grader that scores whether the constraint's
 * load-bearing identifiers survived a produced summary. The runner
 * (eval/experiments/constraint-retention.ts) drives real compaction per arm
 * (baseline / section-only / verbatim) and feeds summaries here.
 *
 * Grading is by verbatim identifier survival, not meaning: a summary that keeps
 * the sense of a rule but drops the exact path/name/version is scored a loss,
 * because the resumed model cannot reliably act on a vague memory. This makes
 * the metric deterministic (no judge model) and conservative.
 */

import type { ProviderMessage } from "../../src/providers/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SeededConstraint {
  /** Stable id for reporting. */
  readonly id: string;
  /** Human description of what the user established. */
  readonly description: string;
  /**
   * Literal strings whose survival is load-bearing — the identifiers the
   * resumed model needs to honor the constraint (paths, names, versions).
   * A constraint is "retained" only when ALL of these appear in the summary.
   */
  readonly mustContain: readonly string[];
  /**
   * True when the byte-exact CC prompt already covers this via its
   * security-verbatim language — a control: the baseline arm should retain it,
   * so it isolates TE-25's *non-security* gap from noise.
   */
  readonly securityCovered?: boolean;
}

export interface ConstraintFixture {
  readonly id: string;
  /**
   * A session whose EARLY turn states the constraint, followed by enough
   * unrelated work that the constraint-bearing message folds under compaction.
   */
  readonly messages: readonly ProviderMessage[];
  readonly constraints: readonly SeededConstraint[];
}

function user(text: string): ProviderMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): ProviderMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** Filler work so the constraint-bearing early turn is well past the tail. */
function fillerTurns(n: number): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(user(`Continue with unrelated step ${i + 1}: refactor a helper and run the tests.`));
    out.push(
      assistant(
        `Step ${i + 1} done — updated the helper in module ${i + 1}, ran the suite, all green. ` +
          "Nothing here changes any earlier decision.",
      ),
    );
  }
  return out;
}

/**
 * Built-in fixtures spanning the constraint classes docs/55 names. Each states
 * the rule once, up front, then buries it under filler so a fold must actively
 * preserve it. `securityCovered` marks the control the CC baseline already
 * handles.
 */
export const CONSTRAINT_FIXTURES: readonly ConstraintFixture[] = [
  {
    id: "never-touch-path",
    messages: [
      user(
        "Before we start: never modify anything under `src/legacy/` — it's vendored code we re-sync from upstream, and local edits get clobbered.",
      ),
      assistant("Understood — I'll treat src/legacy/ as read-only and never edit files there."),
      ...fillerTurns(8),
    ],
    constraints: [
      {
        id: "legacy-readonly",
        description: "Never modify files under src/legacy/ (vendored).",
        mustContain: ["src/legacy/"],
      },
    ],
  },
  {
    id: "chosen-name",
    messages: [
      user(
        "One naming rule for this work: the new table must be called `audit_events`, not `audit_log` — `audit_log` already exists and means something else.",
      ),
      assistant("Got it — I'll name the new table audit_events and avoid audit_log."),
      ...fillerTurns(8),
    ],
    constraints: [
      {
        id: "table-name",
        description: "The new table must be named audit_events (not audit_log).",
        mustContain: ["audit_events"],
      },
    ],
  },
  {
    id: "version-pin",
    messages: [
      user(
        "Hard requirement: pin React to exactly `18.2.0`. Do not upgrade it, even a patch — 18.3+ breaks our SSR shim.",
      ),
      assistant("Understood — React stays pinned at 18.2.0, no upgrades."),
      ...fillerTurns(8),
    ],
    constraints: [
      {
        id: "react-pin",
        description: "Pin React to exactly 18.2.0 (no upgrade).",
        mustContain: ["18.2.0"],
      },
    ],
  },
  {
    id: "library-choice",
    messages: [
      user(
        "Use `zod` for all new schema validation — we're standardizing on it and removing `yup`. Don't add any new yup usage.",
      ),
      assistant("Understood — zod for new validation, no new yup."),
      ...fillerTurns(8),
    ],
    constraints: [
      {
        id: "validation-lib",
        description: "Use zod for validation, not yup.",
        mustContain: ["zod"],
      },
    ],
  },
  {
    id: "secret-handling",
    messages: [
      user(
        "The deploy token lives in `$DEPLOY_TOKEN`. Never hardcode it, never log it, never echo it into a command — read it from the env only.",
      ),
      assistant("Understood — I'll only read DEPLOY_TOKEN from the environment and never log or hardcode it."),
      ...fillerTurns(8),
    ],
    constraints: [
      {
        id: "deploy-token",
        description: "Never hardcode/log $DEPLOY_TOKEN; read from env only.",
        mustContain: ["DEPLOY_TOKEN"],
        securityCovered: true,
      },
    ],
  },
];

/**
 * HARD fixtures — the discriminating set (docs/55). The default fixtures state
 * each rule prominently in the first user turn around a single distinctive
 * identifier, a shape gpt-5.5 preserved at 100% even with reasoning disabled
 * (baseline saturated → the arms couldn't be told apart). These deliberately
 * stress the summary's tendency to drop non-prominent detail:
 *
 *   - stated *in passing*, mid-session, woven into a larger work message (not a
 *     standalone "Hard requirement:"),
 *   - *multiple* constraints per fixture,
 *   - *paraphrasable* identifiers (a summary that keeps the sense but rewords —
 *     `snake_case`→"snake case", `enable_new_checkout`→"the checkout flag" —
 *     scores a loss, which is the whole point),
 *   - buried under more filler.
 *
 * Numeric tokens stay clear of the filler's step/module counters (which only go
 * up to ~12) so a bare number can't false-positive.
 */
export const HARD_CONSTRAINT_FIXTURES: readonly ConstraintFixture[] = [
  {
    id: "aside-config-field",
    messages: [
      ...fillerTurns(2),
      user(
        "For the metrics work: add the p99 latency panel, wire it to the existing Grafana datasource, and — while you're editing that config — leave the `legacyTimeoutMs` default alone; a few old clients still depend on it being `15000`. Then add the alerting rule.",
      ),
      assistant(
        "Will do — p99 panel on the existing datasource, alerting rule added, and I'll leave legacyTimeoutMs at 15000 untouched.",
      ),
      ...fillerTurns(8),
    ],
    constraints: [
      {
        id: "legacy-timeout",
        description: "Don't change the legacyTimeoutMs default (15000).",
        mustContain: ["legacyTimeoutMs", "15000"],
      },
    ],
  },
  {
    id: "in-passing-ground-rules",
    messages: [
      ...fillerTurns(3),
      user(
        "Before you scaffold the endpoint — a few ground rules I keep forgetting to write down: use `snake_case` for all the new API response fields, put the migration under `db/migrations/2024/`, and cap the import batch size at `500` rows so we don't blow the memory limit. Otherwise proceed however you like.",
      ),
      assistant(
        "Noted — snake_case response fields, migration in db/migrations/2024/, import batches capped at 500 rows.",
      ),
      ...fillerTurns(8),
    ],
    constraints: [
      { id: "field-casing", description: "New API fields use snake_case.", mustContain: ["snake_case"] },
      {
        id: "migration-path",
        description: "Migration goes under db/migrations/2024/.",
        mustContain: ["db/migrations/2024/"],
      },
      { id: "batch-cap", description: "Import batch size capped at 500 rows.", mustContain: ["500"] },
    ],
  },
  {
    id: "paraphrasable-flag",
    messages: [
      ...fillerTurns(3),
      user(
        "Then gate the rollout behind a feature flag. Name it exactly `enable_new_checkout` — marketing keyed their launch dashboards to that literal string, so it can't be renamed, prefixed, or namespaced.",
      ),
      assistant("Understood — the flag will be exactly enable_new_checkout, no prefix or namespace."),
      ...fillerTurns(8),
    ],
    constraints: [
      {
        id: "flag-name",
        description: "Feature flag must be literally enable_new_checkout.",
        mustContain: ["enable_new_checkout"],
      },
    ],
  },
  {
    id: "buried-bucket",
    messages: [
      user(
        "Real quick before we dig in: any test uploads go to the staging bucket `acme-staging-uploads`, never the prod bucket. Okay — now onto the actual task, which is the bigger refactor below.",
      ),
      assistant("Got it — test uploads only to acme-staging-uploads, never prod. Starting the refactor."),
      ...fillerTurns(11),
    ],
    constraints: [
      {
        id: "staging-bucket",
        description: "Test uploads go to acme-staging-uploads, not prod.",
        mustContain: ["acme-staging-uploads"],
      },
    ],
  },
  {
    id: "casual-version-pin",
    messages: [
      ...fillerTurns(4),
      user(
        "Also — not urgent, just don't let a lockfile refresh drag it forward — we're staying on Node `20.11.1` for now; the newer releases break our native addon build.",
      ),
      assistant("Understood — Node stays at 20.11.1; I won't let a lockfile refresh bump it."),
      ...fillerTurns(7),
    ],
    constraints: [
      {
        id: "node-pin",
        description: "Stay on Node 20.11.1 (don't bump).",
        mustContain: ["20.11.1"],
      },
    ],
  },
];

/** Named fixture sets the runner can select via OPENSWARM_EVAL_FIXTURES. */
export const FIXTURE_SETS: Record<string, readonly ConstraintFixture[]> = {
  default: CONSTRAINT_FIXTURES,
  hard: HARD_CONSTRAINT_FIXTURES,
  all: [...CONSTRAINT_FIXTURES, ...HARD_CONSTRAINT_FIXTURES],
};

/** Resolve a fixture-set name (default when unknown/empty). */
export function selectFixtureSet(name: string | undefined): readonly ConstraintFixture[] {
  return FIXTURE_SETS[(name ?? "").trim().toLowerCase()] ?? CONSTRAINT_FIXTURES;
}

// ---------------------------------------------------------------------------
// Grader
// ---------------------------------------------------------------------------

export interface ConstraintGrade {
  readonly constraintId: string;
  readonly retained: boolean;
  /** mustContain tokens absent from the summary (empty when retained). */
  readonly missing: readonly string[];
  readonly securityCovered: boolean;
}

export interface FixtureGrade {
  readonly fixtureId: string;
  readonly constraints: readonly ConstraintGrade[];
  /** Retained constraints / total in this fixture. */
  readonly retainedFraction: number;
}

/** Collapse whitespace and lowercase for a forgiving substring check. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Grade one produced summary against a fixture's seeded constraints. A
 * constraint is retained only when every load-bearing token survives.
 */
export function gradeConstraintRetention(
  summary: string,
  fixture: ConstraintFixture,
): FixtureGrade {
  const hay = normalize(summary);
  const constraints = fixture.constraints.map((c): ConstraintGrade => {
    const missing = c.mustContain.filter((tok) => !hay.includes(normalize(tok)));
    return {
      constraintId: c.id,
      retained: missing.length === 0,
      missing,
      securityCovered: c.securityCovered === true,
    };
  });
  const retained = constraints.filter((c) => c.retained).length;
  return {
    fixtureId: fixture.id,
    constraints,
    retainedFraction: constraints.length === 0 ? 1 : retained / constraints.length,
  };
}

// ---------------------------------------------------------------------------
// Aggregation across an arm
// ---------------------------------------------------------------------------

export interface ArmRetention {
  readonly label: string;
  readonly grades: readonly FixtureGrade[];
}

export interface ArmSummary {
  readonly label: string;
  /** All constraints retained / all constraints across fixtures. */
  readonly overall: number;
  /** Retention restricted to non-security constraints (TE-25's actual gap). */
  readonly nonSecurity: number;
  readonly totalConstraints: number;
  readonly retainedConstraints: number;
}

export function summarizeArm(arm: ArmRetention): ArmSummary {
  const all = arm.grades.flatMap((g) => g.constraints);
  const nonSec = all.filter((c) => !c.securityCovered);
  const retained = all.filter((c) => c.retained).length;
  const nonSecRetained = nonSec.filter((c) => c.retained).length;
  return {
    label: arm.label,
    overall: all.length === 0 ? 1 : retained / all.length,
    nonSecurity: nonSec.length === 0 ? 1 : nonSecRetained / nonSec.length,
    totalConstraints: all.length,
    retainedConstraints: retained,
  };
}

/** Markdown comparison table across arms — the report the runner prints. */
export function renderRetentionReport(arms: readonly ArmRetention[]): string {
  const summaries = arms.map(summarizeArm);
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const rows = summaries.map(
    (s) =>
      `| ${s.label} | ${pct(s.overall)} | ${pct(s.nonSecurity)} | ${s.retainedConstraints}/${s.totalConstraints} |`,
  );
  const lines = [
    "| arm | overall retention | non-security retention | retained/total |",
    "|-----|-------------------|------------------------|----------------|",
    ...rows,
  ];
  // Per-fixture detail for the losses.
  const detail: string[] = [];
  for (const arm of arms) {
    const losses = arm.grades.flatMap((g) =>
      g.constraints
        .filter((c) => !c.retained)
        .map((c) => `  - ${arm.label}/${g.fixtureId}/${c.constraintId}: missing ${c.missing.join(", ")}`),
    );
    if (losses.length > 0) {
      detail.push(`\nlosses (${arm.label}):`, ...losses);
    }
  }
  return lines.join("\n") + (detail.length > 0 ? "\n" + detail.join("\n") : "");
}
