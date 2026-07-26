/**
 * Harness guards — agent-synthesized, episode-scoped compliance guards.
 *
 * This is docs/63 P0 ("agent-synthesized compliance guards") and the first
 * concrete `HarnessDelta` kind from docs/64 §3.1. A guard is a *pre-hoc*
 * predicate evaluated in `ToolDispatcher.dispatch` after schema validation and
 * before `tool.execute()`: if the predicate matches, the call is **blocked**
 * with the guard's message instead of executing.
 *
 * Three design decisions, all deliberate for P0:
 *
 * 1. **Declarative predicates, not synthesized code.** AutoHarness
 *    (arXiv:2603.03329) synthesizes executable harness code; we accept a
 *    narrower predicate language instead. It is safe (no `eval` on the tool
 *    hot path), fast, inspectable, and — importantly for docs/64 §7 OQ1 —
 *    **deterministic**, so a guard proposal is reproducible under a seed. The
 *    predicate grammar can widen later; `eval` cannot be un-shipped.
 *
 * 2. **Restrictive only.** A guard can *block* a call and nothing else. This
 *    encodes docs/63's "an in-flight self-edit may constrain the agent, never
 *    liberate it" — widening (new tools, elevated permissions) goes through
 *    the operator-brokered `request_permissions` path, not here.
 *
 * 3. **Episode-scoped and in-memory.** P0 guards die with the process.
 *    Promotion to durable storage (docs/64 §3.4: candidate → cognitive-core
 *    `MutationGate`) is deliberately NOT implemented here — a guard must first
 *    earn its keep against the free/exact signal within an episode.
 *
 * A nice consequence of (1): the `touched` field set of docs/64's
 * `MachineryStamp` is **statically derivable** from the predicate tree
 * (`touchedFields()` below), so P0 needs none of the runtime `Proxy`
 * instrumentation that doc contemplated for code-shaped guards.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Predicate language
// ---------------------------------------------------------------------------

/**
 * A predicate over a tool call's (already schema-validated) input.
 *
 * Semantics: **a predicate that evaluates `true` is a violation** — the guard
 * fires and the call is blocked. Read a guard as "block when <predicate>".
 */
export type GuardPredicate =
  /** Field is absent, null, or an empty string. */
  | { readonly kind: "field_absent"; readonly field: string }
  /** Field, stringified, matches this regular expression. */
  | { readonly kind: "field_matches"; readonly field: string; readonly pattern: string }
  /** Field, stringified, is shorter than `length` characters. */
  | { readonly kind: "field_length_lt"; readonly field: string; readonly length: number }
  | { readonly kind: "all"; readonly of: readonly GuardPredicate[] }
  | { readonly kind: "any"; readonly of: readonly GuardPredicate[] }
  | { readonly kind: "not"; readonly of: GuardPredicate };

export const guardPredicateSchema: z.ZodType<GuardPredicate> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("field_absent"), field: z.string().min(1) }),
    z.object({
      kind: z.literal("field_matches"),
      field: z.string().min(1),
      pattern: z.string().min(1),
    }),
    z.object({
      kind: z.literal("field_length_lt"),
      field: z.string().min(1),
      length: z.number().int().positive(),
    }),
    z.object({ kind: z.literal("all"), of: z.array(guardPredicateSchema).min(1) }),
    z.object({ kind: z.literal("any"), of: z.array(guardPredicateSchema).min(1) }),
    z.object({ kind: z.literal("not"), of: guardPredicateSchema }),
  ]),
) as z.ZodType<GuardPredicate>;

// ---------------------------------------------------------------------------
// The guard (a HarnessDelta of kind "guard" — docs/64 §3.1)
// ---------------------------------------------------------------------------

export interface HarnessGuard {
  /** Stable id. Content-addressed by `guardId()` when synthesized. */
  readonly id: string;
  /** The tool whose dispatch this guard gates. */
  readonly targetTool: string;
  /** Block the call when this evaluates true. */
  readonly predicate: GuardPredicate;
  /** Shown to the model when the guard blocks a call. Should say how to comply. */
  readonly message: string;
  /** Why this guard exists — the failure it was synthesized from (docs/64 §3.1). */
  readonly failureSignature: string;
  /**
   * docs/63's narrowing invariant, encoded as a literal type: a guard may only
   * constrain. There is deliberately no other admissible value.
   */
  readonly effect: "restrictive";
}

/** Per-guard counters — the LH1 metric surface (docs/64 §8). */
export interface GuardEvidence {
  /** Times the predicate was evaluated. */
  evaluated: number;
  /** Times the predicate matched and the call was blocked. */
  fired: number;
}

export interface GuardVerdict {
  readonly blocked: boolean;
  readonly guardId?: string;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Field access + evaluation
// ---------------------------------------------------------------------------

/** Resolve a dot-path (`"a.b.c"`) against an input object. */
export function resolveField(input: unknown, field: string): unknown {
  const parts = field.split(".");
  let cur: unknown = input;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Evaluate a predicate against a tool input. Never throws — a malformed
 * pattern or unexpected shape evaluates `false` (fail-open), because a broken
 * guard must not block legitimate work. Guards are an optimization on
 * compliance, not a security boundary; the permission engine is the boundary.
 */
export function evaluatePredicate(predicate: GuardPredicate, input: unknown): boolean {
  try {
    switch (predicate.kind) {
      case "field_absent": {
        const v = resolveField(input, predicate.field);
        return v === undefined || v === null || v === "";
      }
      case "field_matches": {
        const v = resolveField(input, predicate.field);
        if (v === undefined) return false;
        return new RegExp(predicate.pattern).test(asString(v));
      }
      case "field_length_lt": {
        const v = resolveField(input, predicate.field);
        if (v === undefined || v === null) return false;
        return asString(v).length < predicate.length;
      }
      case "all":
        return predicate.of.every((p) => evaluatePredicate(p, input));
      case "any":
        return predicate.of.some((p) => evaluatePredicate(p, input));
      case "not":
        return !evaluatePredicate(predicate.of, input);
    }
  } catch {
    return false;
  }
}

/**
 * The set of input fields a predicate reads — statically derivable because the
 * predicate language is declarative. This is docs/64 §5.3's `MachineryStamp
 * .touched` without needing runtime `Proxy` instrumentation.
 */
export function touchedFields(predicate: GuardPredicate): readonly string[] {
  const out = new Set<string>();
  const walk = (p: GuardPredicate): void => {
    switch (p.kind) {
      case "field_absent":
      case "field_matches":
      case "field_length_lt":
        out.add(p.field);
        return;
      case "all":
      case "any":
        p.of.forEach(walk);
        return;
      case "not":
        walk(p.of);
        return;
    }
  };
  walk(predicate);
  return Array.from(out).sort();
}

/** Content-address a guard so the same guard synthesized twice has one id. */
export function guardId(targetTool: string, predicate: GuardPredicate): string {
  const canonical = JSON.stringify({ targetTool, predicate });
  // FNV-1a — stable, dependency-free, and only needs to be collision-resistant
  // across the handful of guards in one episode.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hd-guard-${hash.toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Episode-scoped guard registry. Held by the runtime and consulted by
 * `ToolDispatcher.dispatch`.
 */
export class GuardRegistry {
  private readonly guards = new Map<string, HarnessGuard>();
  private readonly evidence = new Map<string, GuardEvidence>();
  /** Guards indexed by target tool, so dispatch does no scanning. */
  private readonly byTool = new Map<string, string[]>();

  /**
   * Register a guard. Idempotent by content-address: re-registering the same
   * (targetTool, predicate) returns `false` and preserves existing evidence,
   * so an agent that re-proposes a guard does not reset its counters.
   */
  register(guard: HarnessGuard): boolean {
    if (this.guards.has(guard.id)) return false;
    this.guards.set(guard.id, guard);
    this.evidence.set(guard.id, { evaluated: 0, fired: 0 });
    const list = this.byTool.get(guard.targetTool) ?? [];
    list.push(guard.id);
    this.byTool.set(guard.targetTool, list);
    return true;
  }

  /** Remove a guard (e.g. the agent finds it produces false positives). */
  remove(id: string): boolean {
    const guard = this.guards.get(id);
    if (guard === undefined) return false;
    this.guards.delete(id);
    this.evidence.delete(id);
    const list = (this.byTool.get(guard.targetTool) ?? []).filter((g) => g !== id);
    if (list.length === 0) this.byTool.delete(guard.targetTool);
    else this.byTool.set(guard.targetTool, list);
    return true;
  }

  list(): readonly HarnessGuard[] {
    return Array.from(this.guards.values());
  }

  get(id: string): HarnessGuard | undefined {
    return this.guards.get(id);
  }

  evidenceFor(id: string): GuardEvidence | undefined {
    const e = this.evidence.get(id);
    return e === undefined ? undefined : { ...e };
  }

  /**
   * Evaluate every guard registered for `toolName` against `input`. Returns on
   * the first guard that fires — the model gets one actionable message rather
   * than a pile.
   */
  evaluate(toolName: string, input: unknown): GuardVerdict {
    const ids = this.byTool.get(toolName);
    if (ids === undefined || ids.length === 0) return { blocked: false };
    for (const id of ids) {
      const guard = this.guards.get(id);
      if (guard === undefined) continue;
      const ev = this.evidence.get(id);
      if (ev !== undefined) ev.evaluated++;
      if (evaluatePredicate(guard.predicate, input)) {
        if (ev !== undefined) ev.fired++;
        return { blocked: true, guardId: id, message: guard.message };
      }
    }
    return { blocked: false };
  }

  /**
   * Compliance-failure summary — the docs/64 §8 LH1 metric read off one
   * episode. `totalFired` is the count of would-be compliance failures the
   * guards prevented.
   */
  summary(): {
    readonly guardCount: number;
    readonly totalEvaluated: number;
    readonly totalFired: number;
    readonly perGuard: ReadonlyArray<{
      readonly id: string;
      readonly targetTool: string;
      readonly failureSignature: string;
      readonly evidence: GuardEvidence;
    }>;
  } {
    let totalEvaluated = 0;
    let totalFired = 0;
    const perGuard = this.list().map((g) => {
      const ev = this.evidence.get(g.id) ?? { evaluated: 0, fired: 0 };
      totalEvaluated += ev.evaluated;
      totalFired += ev.fired;
      return {
        id: g.id,
        targetTool: g.targetTool,
        failureSignature: g.failureSignature,
        evidence: { ...ev },
      };
    });
    return { guardCount: this.guards.size, totalEvaluated, totalFired, perGuard };
  }
}
