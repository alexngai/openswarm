/**
 * constraint-retention — TE-25 measurement runner (docs/55).
 *
 * Drives REAL compaction over the seeded-constraint fixtures for each arm and
 * grades whether the durable constraint survived the summary:
 *
 *   - baseline  : standing-constraints section OFF (pre-TE-25 byte-exact CC)
 *   - section   : standing-constraints section ON (TE-25a)
 *   - verbatim  : section ON + verbatim user-turn pinning (TE-25b), once landed
 *
 * The arm is selected purely by env flags the compaction path already reads, so
 * this measures the shipped behavior, not a reimplementation.
 *
 * Run (needs a NATIVE transport model + its key, e.g. OpenAI):
 *   OPENAI_API_KEY=sk-... OPENSWARM_EVAL_MODEL=gpt-5.5 \
 *     bun eval/experiments/constraint-retention.ts
 *
 * Optional: OPENSWARM_EVAL_RUNS=3 (runs per fixture per arm; default 2),
 *           OPENSWARM_EVAL_ARMS=baseline,section (subset; default all landed).
 *
 * Claude models resolve to the SDK engine (not a bare Provider), so this runner
 * requires a native transport model — which is also the path TE-25 matters most
 * on. Without a key it prints setup guidance and exits 0 (no fabricated result).
 */
import { resolveProvider } from "../../src/providers/routing.js";
import { OpenAIEnvAuth } from "../../src/auth/openai-env.js";
import { compactSessionRemote } from "../../src/engine/compact-remote.js";
import type { RemoteCompactionConfig } from "../../src/engine/compact-remote.js";
import type { Provider } from "../../src/providers/index.js";
import {
  CONSTRAINT_FIXTURES,
  gradeConstraintRetention,
  renderRetentionReport,
  type ArmRetention,
  type FixtureGrade,
} from "../harness/constraint-retention.js";

interface Arm {
  readonly label: string;
  /** Env overlay applied for this arm (compaction reads these). */
  readonly env: Record<string, string>;
}

// Flags the compaction path reads (TE-25a section, TE-25b verbatim pinning).
const ARMS: readonly Arm[] = [
  {
    label: "baseline",
    env: { OPENSWARM_COMPACT_STANDING_CONSTRAINTS: "0", OPENSWARM_COMPACT_PIN_USER_TURNS: "0" },
  },
  {
    label: "section",
    env: { OPENSWARM_COMPACT_STANDING_CONSTRAINTS: "1", OPENSWARM_COMPACT_PIN_USER_TURNS: "0" },
  },
  {
    label: "verbatim",
    env: { OPENSWARM_COMPACT_STANDING_CONSTRAINTS: "1", OPENSWARM_COMPACT_PIN_USER_TURNS: "1" },
  },
];

const PIN_FLAG = "OPENSWARM_COMPACT_PIN_USER_TURNS";
const SECTION_FLAG = "OPENSWARM_COMPACT_STANDING_CONSTRAINTS";

function applyEnv(overlay: Record<string, string>): void {
  for (const [k, v] of Object.entries(overlay)) process.env[k] = v;
}

async function buildProvider(model: string): Promise<Provider> {
  const resolved = resolveProvider(model);
  if (resolved.kind !== "native" || resolved.providerFactory === undefined) {
    throw new Error(
      `model "${model}" does not resolve to a native transport provider ` +
        `(kind=${resolved.kind}). Use an OpenAI/xAI/Gemini/LiteLLM model — Claude ` +
        `models run through the SDK engine, which this runner can't drive directly.`,
    );
  }
  const auth = resolved.authFactory !== undefined ? await resolved.authFactory() : new OpenAIEnvAuth();
  return resolved.providerFactory(auth, resolved.modelId ?? model);
}

async function runArm(
  arm: Arm,
  provider: Provider,
  model: string,
  runsPerFixture: number,
): Promise<ArmRetention> {
  applyEnv(arm.env);
  const grades: FixtureGrade[] = [];
  for (const fixture of CONSTRAINT_FIXTURES) {
    // Best-of-N over model nondeterminism: a constraint counts as retained if
    // it survives in ANY run (the resumed model only needs one good summary).
    // Report the best grade so a single unlucky sample doesn't dominate.
    let best: FixtureGrade | undefined;
    for (let r = 0; r < runsPerFixture; r++) {
      const config: RemoteCompactionConfig = {
        provider,
        model,
        preserveRecentMessages: 2,
        maxEstimatedTokens: 1, // force the trigger regardless of size
        timeoutMs: 120_000,
      };
      const result = await compactSessionRemote(
        { messages: [...fixture.messages] },
        config,
        undefined,
        { force: true },
      );
      const grade = gradeConstraintRetention(result.summary, fixture);
      if (best === undefined || grade.retainedFraction > best.retainedFraction) {
        best = grade;
      }
      process.stderr.write(
        `[constraint-retention] ${arm.label}/${fixture.id} run ${r + 1}/${runsPerFixture}: ` +
          `${Math.round(grade.retainedFraction * 100)}%\n`,
      );
    }
    grades.push(best!);
  }
  return { label: arm.label, grades };
}

async function main(): Promise<void> {
  const model = process.env.OPENSWARM_EVAL_MODEL ?? "gpt-5.5";
  const runsPerFixture = Number(process.env.OPENSWARM_EVAL_RUNS ?? "2") || 2;
  const armFilter = (process.env.OPENSWARM_EVAL_ARMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const arms = armFilter.length > 0 ? ARMS.filter((a) => armFilter.includes(a.label)) : ARMS;

  let provider: Provider;
  try {
    provider = await buildProvider(model);
  } catch (err) {
    console.error(`[constraint-retention] cannot run: ${(err as Error).message}`);
    console.error(
      "\nSet a native transport model + key, e.g.:\n" +
        "  OPENAI_API_KEY=sk-... OPENSWARM_EVAL_MODEL=gpt-5.5 bun eval/experiments/constraint-retention.ts",
    );
    return;
  }

  // Snapshot the flags we mutate so arms don't leak into the caller's env.
  const saved = { ...process.env };
  const results: ArmRetention[] = [];
  try {
    for (const arm of arms) {
      process.stderr.write(`\n[constraint-retention] arm: ${arm.label}\n`);
      results.push(await runArm(arm, provider, model, runsPerFixture));
    }
  } finally {
    for (const flag of [SECTION_FLAG, PIN_FLAG]) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  }

  console.log(`\n# TE-25 constraint retention (model: ${model}, ${runsPerFixture} run(s)/fixture, best-of)\n`);
  console.log(renderRetentionReport(results));
}

await main();
