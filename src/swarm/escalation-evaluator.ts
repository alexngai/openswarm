/**
 * escalation-evaluator.ts — pluggable, benchmark-specific escalation signals for
 * the cascade (docs/50 G3 v2; §9.3).
 *
 * The cascade gates escalation on a confidence ∈ [0,1] that a tier's attempt is
 * correct/complete. WHERE that confidence comes from is benchmark-specific: a SWE
 * task runs the repo's visible tests (pytest pass-rate), fixit reads checkpoint
 * scores, SWT-Bench scores a generated test, and the v1 fallback just parses a
 * self-reported sentinel. So the signal is an INTERFACE, resolved by name from a
 * registry (mirroring RoleRegistry / RecoveryRegistry) and injected into
 * `CascadeTopology` via TopologyContext.
 *
 * INTEGRITY RULE (docs/50 §8.1): an evaluator must derive confidence only from
 * information the agent legitimately has — pre-existing/visible tests, an authored
 * test, compile/lint, cross-attempt agreement. It must NEVER read the held-out
 * grader tests; that is leakage and invalidates the study. Evaluators run at
 * cascade time; the scoring grader stays sealed until final scoring.
 *
 * Pure/composable — evaluators take an `exec` capability (injected by the harness so
 * the same evaluator works in-process or inside an E2B sandbox) rather than reaching
 * for a shell themselves. Hard failures (crashed tier) are handled by the topology
 * from the run status; evaluators only grade a tier that terminated successfully.
 */

import { combineConfidence, type Confidence } from "./escalation-gate.js";
import type { AgentResult } from "./host.js";

/** Result of running a command in the tier's workspace. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command in a workspace. Injected by the harness (local shell / E2B / …). */
export type ExecFn = (
  command: string,
  opts?: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<ExecResult>;

/** Everything an evaluator may use to score a successful tier attempt. */
export interface EscalationContext {
  /** The tier's terminal result (output + usage). Only successful tiers reach here. */
  readonly result: AgentResult;
  /** Workspace the tier ran in (worktree / sandbox path), when known. */
  readonly cwd?: string;
  /** Tier index in the cascade (0 = cheapest). */
  readonly index: number;
  /** Opaque per-task metadata a benchmark evaluator understands (visible tests, checkpoints, …). */
  readonly task?: unknown;
  /** Run a command in the workspace. Absent ⇒ execution-based evaluators can't grade. */
  readonly exec?: ExecFn;
}

/** A benchmark-specific escalation signal. `name` is its registry key. */
export interface EscalationEvaluator {
  readonly name: string;
  evaluate(ctx: EscalationContext): Promise<Confidence>;
}

// ---------------------------------------------------------------------------
// Self-report (v1 fallback)
// ---------------------------------------------------------------------------

/** Confidence from a self-reported sentinel: `CASCADE_SOLVED` ⇒ 1, `CASCADE_CONFIDENCE: n` ⇒ n, else 0. */
export function parseSelfReportConfidence(output: string): Confidence {
  const m = /CASCADE_CONFIDENCE:\s*([0-9]*\.?[0-9]+)/i.exec(output);
  if (m !== null) {
    const v = Number(m[1]);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }
  return /CASCADE_SOLVED/i.test(output) ? 1 : 0;
}

/** The v1 default: trusts the tier's own sentinel. Cheap, no execution, weakly calibrated. */
export class SelfReportEvaluator implements EscalationEvaluator {
  readonly name = "self-report";
  evaluate(ctx: EscalationContext): Promise<Confidence> {
    const r = ctx.result;
    const output = r.status === "success" ? r.output ?? "" : "";
    return Promise.resolve(parseSelfReportConfidence(output));
  }
}

// ---------------------------------------------------------------------------
// Command / execution signal
// ---------------------------------------------------------------------------

/** 1 when the command exited 0, else 0 — the cheap "compiles / applies" gate. */
export function exitCodeGate(r: ExecResult): Confidence {
  return r.exitCode === 0 ? 1 : 0;
}

/**
 * Pass-rate from pytest-style output ("N passed, M failed, …"). Graded ∈ [0,1]. No
 * recognizable counts → falls back to the exit-code gate (0 or 1). Only counts the
 * VISIBLE tests it was pointed at — never the held-out grader tests (§8.1).
 */
export function parsePytestPassRate(r: ExecResult): Confidence {
  const text = `${r.stdout}\n${r.stderr}`;
  const passed = Number(/(\d+)\s+passed/i.exec(text)?.[1] ?? "0");
  const failed = Number(/(\d+)\s+failed/i.exec(text)?.[1] ?? "0");
  const errored = Number(/(\d+)\s+error(?:s|ed)?/i.exec(text)?.[1] ?? "0");
  const total = passed + failed + errored;
  if (total === 0) return exitCodeGate(r);
  return Math.max(0, Math.min(1, passed / total));
}

export interface CommandEvaluatorOptions {
  readonly name: string;
  /** Command to run in the workspace (e.g. the repo's visible test subset). */
  readonly command: string;
  /** Benchmark-specific parser: ExecResult → confidence. Defaults to pytest pass-rate. */
  readonly parse?: (r: ExecResult) => Confidence;
  readonly timeoutMs?: number;
}

/**
 * Runs a configured command in the tier's workspace and parses the result into a
 * confidence. The generic execution signal — a benchmark supplies its command +
 * parser. Returns 0 (⇒ escalate) when no `exec` is available.
 */
export class CommandEvaluator implements EscalationEvaluator {
  readonly name: string;
  private readonly command: string;
  private readonly parse: (r: ExecResult) => Confidence;
  private readonly timeoutMs?: number;

  constructor(opts: CommandEvaluatorOptions) {
    this.name = opts.name;
    this.command = opts.command;
    this.parse = opts.parse ?? parsePytestPassRate;
    this.timeoutMs = opts.timeoutMs;
  }

  async evaluate(ctx: EscalationContext): Promise<Confidence> {
    if (ctx.exec === undefined) return 0; // can't run ⇒ unknown ⇒ escalate
    const r = await ctx.exec(this.command, {
      ...(ctx.cwd !== undefined && { cwd: ctx.cwd }),
      ...(this.timeoutMs !== undefined && { timeoutMs: this.timeoutMs }),
    });
    return this.parse(r);
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Combines child evaluators via `combineConfidence` (weakest link / min by default),
 * so "compile-gate × regression-rate × fix-signal" is one evaluator. A single child
 * scoring 0 (e.g. a patch that doesn't build) drags the whole confidence to 0.
 */
export class CompositeEvaluator implements EscalationEvaluator {
  readonly name: string;
  private readonly children: readonly EscalationEvaluator[];
  private readonly combine: (...c: Confidence[]) => Confidence;

  constructor(
    name: string,
    children: readonly EscalationEvaluator[],
    combine: (...c: Confidence[]) => Confidence = combineConfidence,
  ) {
    this.name = name;
    this.children = children;
    this.combine = combine;
  }

  async evaluate(ctx: EscalationContext): Promise<Confidence> {
    if (this.children.length === 0) return 0;
    const scores = await Promise.all(this.children.map((c) => c.evaluate(ctx)));
    return this.combine(...scores);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Resolves an escalation-evaluator name to its implementation. Benchmarks register their own. */
export class EvaluatorRegistry {
  private readonly map = new Map<string, EscalationEvaluator>();

  register(evaluator: EscalationEvaluator): this {
    this.map.set(evaluator.name, evaluator);
    return this;
  }

  /** Resolve by name; undefined name or unknown key → undefined (caller falls back). */
  select(name?: string): EscalationEvaluator | undefined {
    return name === undefined ? undefined : this.map.get(name);
  }

  names(): string[] {
    return [...this.map.keys()];
  }
}

/** A registry seeded with the built-in evaluators. Benchmarks `.register()` more onto it. */
export function defaultEvaluatorRegistry(): EvaluatorRegistry {
  return new EvaluatorRegistry().register(new SelfReportEvaluator());
}
