/**
 * eval-plan.ts — the preregistered evaluation plan for `DDP-EVAL-01` (`FX-EVAL-PLAN-001`).
 *
 * docs/63 asks `WP-01` to preregister the mixed corpus, one comparator per workflow, paired seeds,
 * the bootstrap analysis, the −5-point success margin, and the 1.25× latency and 1.15× cost
 * guardrails. Preregistration is the whole value: fixing the corpus, the comparators, and the
 * decision rule before any number exists is what stops the eventual result from being the product of
 * choosing a favourable configuration.
 *
 * Two things are deliberately left unpinned, and are `null` rather than invented:
 *
 *   - Comparator versions. Pinning a competitor's release now would pin a stale one by the time
 *     `WP-28` runs; the rule preregistered instead is "latest stable at matrix start, recorded in the
 *     artifact".
 *   - Repository snapshot SHAs. The repositories are named now, which is the part that could
 *     otherwise be cherry-picked; the snapshots are taken once at `WP-28` and recorded.
 *
 * The statistical procedure itself lives in `statistics.ts` and is implemented and tested here rather
 * than at `WP-28`, so it cannot be adjusted after seeing results.
 */
import { requiredPairs } from "./statistics.js";
import type { CertifiedProvider } from "./certification.js";

/** The decision thresholds, exactly as docs/63 states them. */
export interface EvalMargins {
  /** Non-inferiority margin for task success, in percentage points. */
  readonly successMarginPp: number;
  /** Maximum median wall-time ratio against the comparator. */
  readonly latencyRatioMax: number;
  /** Maximum median model-cost ratio against the comparator. */
  readonly costRatioMax: number;
  readonly bootstrapIterations: number;
  /** Two-sided significance level; the reported bound is the lower end. */
  readonly alpha: number;
  /** Assumed σ_d for the paired difference, from docs/50 §3.1. */
  readonly sigmaD: number;
  /** Minimum detectable effect as a proportion. */
  readonly mde: number;
}

export const EVAL_MARGINS: EvalMargins = {
  successMarginPp: 5,
  latencyRatioMax: 1.25,
  costRatioMax: 1.15,
  bootstrapIterations: 10_000,
  alpha: 0.05,
  sigmaD: 0.3,
  mde: 0.05,
};

/** Paired instances required before a result can be conclusive. Derived, not asserted. */
export const MINIMUM_PAIRS = requiredPairs(
  EVAL_MARGINS.sigmaD,
  EVAL_MARGINS.mde,
  EVAL_MARGINS.alpha,
);

/**
 * Paired seeds. Both arms run every task at every seed, so a difference cannot come from one arm
 * having drawn easier sampling luck. Five seeds matches the docs/61 finding that fewer than three
 * makes difficulty classification too noisy to trust.
 */
export const SEEDS: readonly number[] = [1, 2, 3, 4, 5];

export type CorpusSegmentKind =
  | "deterministic-synthetic"
  | "security-fixture"
  | "public-repository"
  | "private-holdout";

export interface CorpusSegment {
  readonly id: string;
  readonly kind: CorpusSegmentKind;
  readonly description: string;
  /** Languages exercised, where the segment is language-specific. */
  readonly languages?: readonly ("typescript" | "python" | "go")[];
  /** Snapshot identifier, pinned at `WP-28` rather than now. */
  readonly snapshot: string | null;
  /**
   * Whether the segment contributes to the comparative success statistic. Deterministic safety and
   * correctness segments are 100% gates and must not be averaged into a comparative metric, which is
   * how a failed safety capability would otherwise be hidden by a good aggregate.
   */
  readonly comparative: boolean;
}

export const CORPUS: readonly CorpusSegment[] = [
  {
    id: "CORPUS-SYNTH-01",
    kind: "deterministic-synthetic",
    description:
      "Hand-built repositories with known-correct fixes, used for deterministic conformance rather than comparison.",
    languages: ["typescript", "python", "go"],
    snapshot: null,
    comparative: false,
  },
  {
    id: "CORPUS-SEC-01",
    kind: "security-fixture",
    description:
      "Malicious-clone, path-escape, SSRF, and extension-abuse fixtures backing the DDP-SAFE-* gates.",
    snapshot: null,
    comparative: false,
  },
  {
    id: "CORPUS-PUB-TS-01",
    kind: "public-repository",
    description:
      "Pinned public TypeScript repositories with real issues and runnable test suites.",
    languages: ["typescript"],
    snapshot: null,
    comparative: true,
  },
  {
    id: "CORPUS-PUB-PY-01",
    kind: "public-repository",
    description:
      "Pinned public Python repositories, overlapping the SWE-bench instances the eval/ harness already prepares.",
    languages: ["python"],
    snapshot: null,
    comparative: true,
  },
  {
    id: "CORPUS-PUB-GO-01",
    kind: "public-repository",
    description:
      "Pinned public Go repositories, the language with the thinnest existing eval coverage.",
    languages: ["go"],
    snapshot: null,
    comparative: true,
  },
  {
    id: "CORPUS-HOLDOUT-01",
    kind: "private-holdout",
    description:
      "Optional private repositories, reported separately. Guards against public-corpus contamination without being able to be tuned against.",
    snapshot: null,
    comparative: true,
  },
];

/** The user-facing workflows parity is measured over. */
export type Workflow =
  | "single-agent-fix"
  | "multi-agent-team"
  | "headless"
  | "acp-editor";

export interface ComparatorSpec {
  readonly workflow: Workflow;
  /** The product compared against, or OpenSwarm itself for internally-paired arms. */
  readonly comparator: string;
  /** Pinned at matrix start: latest stable, recorded in the artifact. */
  readonly version: string | null;
  /** Providers the pairing runs on. Both arms must use the same exact model. */
  readonly providers: readonly CertifiedProvider[];
  readonly rationale: string;
}

/**
 * One comparator per workflow. The team workflow is paired against OpenSwarm's own single agent
 * rather than an external product, because no comparable multi-agent product exists and because
 * docs/63 explicitly defers any claim that swarms outperform a strong single agent — so the honest
 * question for teams is whether they cost more than they return, not whether they beat a rival.
 */
export const COMPARATORS: readonly ComparatorSpec[] = [
  {
    workflow: "single-agent-fix",
    comparator: "claude-code",
    version: null,
    providers: ["anthropic"],
    rationale:
      "The strongest single-agent baseline, and it runs the same Anthropic models, so the pairing isolates product behaviour from model quality.",
  },
  {
    workflow: "multi-agent-team",
    comparator: "openswarm-single-agent",
    version: null,
    providers: ["anthropic", "openai"],
    rationale:
      "No external multi-agent comparator exists. Pairing against our own single agent measures whether a team earns its extra cost, which is the claim we are entitled to make.",
  },
  {
    workflow: "headless",
    comparator: "codex-cli",
    version: null,
    providers: ["openai"],
    rationale:
      "Codex is the non-interactive reference implementation and shares the OpenAI models, matching how DDP-HDL-01 is scoped.",
  },
  {
    workflow: "acp-editor",
    comparator: "opencode",
    version: null,
    providers: ["anthropic"],
    rationale:
      "OpenCode is ACP-native and is the design OpenSwarm's configuration and permission UX was asked to follow, so it is the fair reference for DDP-ACP-01.",
  },
];

/** Structural checks over the plan, reported through the same violation shape as the manifest. */
export interface PlanViolation {
  readonly check: string;
  readonly subject: string;
  readonly message: string;
}

export function validateEvalPlan(): PlanViolation[] {
  const out: PlanViolation[] = [];

  const workflows: readonly Workflow[] = [
    "single-agent-fix",
    "multi-agent-team",
    "headless",
    "acp-editor",
  ];
  for (const workflow of workflows) {
    const matches = COMPARATORS.filter((c) => c.workflow === workflow);
    if (matches.length !== 1) {
      out.push({
        check: "one-comparator-per-workflow",
        subject: workflow,
        message: `expected exactly one comparator, found ${matches.length}`,
      });
    }
  }
  for (const spec of COMPARATORS) {
    if (spec.providers.length === 0) {
      out.push({
        check: "comparator-provider",
        subject: spec.workflow,
        message: "comparator names no provider to pair on",
      });
    }
  }

  for (const kind of [
    "deterministic-synthetic",
    "security-fixture",
    "public-repository",
  ] as const) {
    if (!CORPUS.some((segment) => segment.kind === kind)) {
      out.push({
        check: "corpus-coverage",
        subject: kind,
        message: "the mixed corpus is missing a required segment kind",
      });
    }
  }
  for (const language of ["typescript", "python", "go"] as const) {
    const covered = CORPUS.some(
      (segment) =>
        segment.kind === "public-repository" &&
        segment.languages?.includes(language) === true,
    );
    if (!covered) {
      out.push({
        check: "corpus-coverage",
        subject: language,
        message: "no public-repository segment covers this language",
      });
    }
  }
  for (const segment of CORPUS) {
    if (segment.kind === "security-fixture" && segment.comparative) {
      out.push({
        check: "corpus-gate-not-averaged",
        subject: segment.id,
        message:
          "deterministic safety segments must not contribute to the comparative statistic",
      });
    }
  }

  if (SEEDS.length < 3) {
    out.push({
      check: "seed-count",
      subject: "SEEDS",
      message: "docs/61 requires at least three seeds for stable classification",
    });
  }
  if (new Set(SEEDS).size !== SEEDS.length) {
    out.push({
      check: "seed-count",
      subject: "SEEDS",
      message: "seeds must be distinct",
    });
  }

  return out;
}
