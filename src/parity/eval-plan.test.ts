/**
 * eval-plan.test.ts — `FX-EVAL-PLAN-001`, plus the certification labelling rule.
 *
 * The assertions pin the preregistered numbers and the pessimistic default for model labels. Both are
 * things that would be tempting to soften later: a margin is easier to move than a result, and a
 * candidate model is easier to call certified than to certify.
 */
import { describe, expect, it } from "vitest";
import {
  COMPARATORS,
  CORPUS,
  EVAL_MARGINS,
  MINIMUM_PAIRS,
  SEEDS,
  validateEvalPlan,
} from "./eval-plan.js";
import {
  LSP_SERVERS,
  MODEL_CERTIFICATIONS,
  PINNED_TOOLCHAIN,
  REQUIRED_PROVIDERS,
  evidenceEligibleModels,
  labelFor,
} from "./certification.js";

describe("the preregistered plan", () => {
  it("is internally consistent", () => {
    expect(validateEvalPlan()).toEqual([]);
  });

  it("pins the docs/67 margins and guardrails", () => {
    expect(EVAL_MARGINS.successMarginPp).toBe(5);
    expect(EVAL_MARGINS.latencyRatioMax).toBe(1.25);
    expect(EVAL_MARGINS.costRatioMax).toBe(1.15);
    expect(EVAL_MARGINS.bootstrapIterations).toBe(10_000);
    expect(EVAL_MARGINS.alpha).toBe(0.05);
  });

  it("derives the minimum sample size instead of asserting it", () => {
    expect(MINIMUM_PAIRS).toBe(283);
  });

  it("names exactly one comparator per workflow", () => {
    expect(COMPARATORS.map((c) => c.workflow)).toEqual([
      "single-agent-fix",
      "multi-agent-team",
      "headless",
      "acp-editor",
    ]);
  });

  it("pairs the team workflow against our own single agent", () => {
    // docs/67 defers any claim that swarms beat a strong single agent, so an
    // external comparator here would be measuring a claim we do not make.
    const team = COMPARATORS.find((c) => c.workflow === "multi-agent-team");
    expect(team?.comparator).toBe("openswarm-single-agent");
  });

  it("leaves comparator versions and corpus snapshots unpinned until the matrix runs", () => {
    expect(COMPARATORS.every((c) => c.version === null)).toBe(true);
    expect(CORPUS.every((segment) => segment.snapshot === null)).toBe(true);
  });

  it("covers all three languages with public repositories", () => {
    const languages = new Set(
      CORPUS.filter((s) => s.kind === "public-repository").flatMap(
        (s) => s.languages ?? [],
      ),
    );
    expect([...languages].sort()).toEqual(["go", "python", "typescript"]);
  });

  it("keeps deterministic safety segments out of the comparative statistic", () => {
    const gates = CORPUS.filter(
      (s) => s.kind === "security-fixture" || s.kind === "deterministic-synthetic",
    );
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((s) => !s.comparative)).toBe(true);
  });

  it("uses at least the three seeds docs/61 requires, all distinct", () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SEEDS).size).toBe(SEEDS.length);
  });
});

describe("model certification", () => {
  it("names one candidate for each required provider", () => {
    for (const provider of REQUIRED_PROVIDERS) {
      const entries = MODEL_CERTIFICATIONS.filter(
        (m) => m.provider === provider,
      );
      expect(entries).toHaveLength(1);
    }
  });

  it("certifies nothing yet, because WP-16 has not run", () => {
    expect(MODEL_CERTIFICATIONS.every((m) => m.status === "candidate")).toBe(
      true,
    );
    expect(MODEL_CERTIFICATIONS.every((m) => m.certifiedOn === undefined)).toBe(
      true,
    );
    expect(evidenceEligibleModels()).toEqual([]);
  });

  it("labels a candidate unverified rather than certified", () => {
    expect(labelFor("claude-sonnet-4-6")).toBe("unverified");
  });

  it("labels an unknown model unverified", () => {
    expect(labelFor("some-new-model-2027")).toBe("unverified");
  });

  it("pins exact API identifiers rather than aliases", () => {
    // An alias can be repointed; a certification that follows an alias is not a
    // certification of anything in particular.
    const ids = MODEL_CERTIFICATIONS.map((m) => m.modelId);
    expect(ids).not.toContain("sonnet");
    expect(ids).not.toContain("gpt-5");
    expect(ids).toContain("gpt-5-2025-08-07");
  });

  it("gives every candidate a stated rationale", () => {
    expect(
      MODEL_CERTIFICATIONS.every((m) => m.rationale.trim().length > 0),
    ).toBe(true);
  });
});

describe("environment pins", () => {
  it("matches the toolchain Dockerfile.parity installs", async () => {
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync("Dockerfile.parity", "utf8");
    expect(dockerfile).toContain(`FROM ${PINNED_TOOLCHAIN.baseImage}`);
    expect(dockerfile).toContain(
      `BUN_VERSION=${PINNED_TOOLCHAIN.bunVersion}`,
    );
    expect(PINNED_TOOLCHAIN.baseImage).toContain(PINNED_TOOLCHAIN.nodeVersion);
  });

  it("names the three certified LSP servers without inventing versions", () => {
    expect(LSP_SERVERS.map((s) => s.language)).toEqual([
      "typescript",
      "python",
      "go",
    ]);
    expect(LSP_SERVERS.every((s) => s.version === null)).toBe(true);
  });
});
