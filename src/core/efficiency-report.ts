/**
 * efficiency-report.ts — pure parsing/summary math for the local cache/token
 * A/B harness (docs/55 TE-22).
 *
 * `scripts/cache-ab.ts` runs a fixed headless task per arm and feeds each
 * run's JSONL event stream through `parseRunJsonl`; this module reduces the
 * streams to comparable per-run stats and formats an A/B table. Pure module —
 * no I/O, no spawning — so the column math is unit-testable and stays in one
 * place (the same cache%/ctx-per-turn formulas as /cost, /status, and the
 * cost-frontier eval).
 */

import { ApiCostModel } from "./cost-model.js";

// ---------------------------------------------------------------------------
// Per-run stats
// ---------------------------------------------------------------------------

export interface RunStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  /** message_stop events seen (turn boundaries within the run). */
  readonly turns: number;
  /** Attributed cache-miss causes seen across the run (TE-21), deduped. */
  readonly missReasons: readonly string[];
  /** Wall-clock of the run, stamped by the harness (not parsed from JSONL). */
  readonly wallClockMs?: number;
}

/**
 * Reduce one headless run's JSONL lines to RunStats. Non-JSON lines and
 * unknown event types are skipped (stderr noise never reaches this — the
 * harness feeds stdout only). The LAST message_stop's usage wins: engines
 * report a cumulative tally, so the final stop covers the whole run.
 */
export function parseRunJsonl(lines: readonly string[]): RunStats {
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  let turns = 0;
  const missReasons = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof evt !== "object" || evt === null) continue;
    const e = evt as {
      type?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
      payload?: { changedComponents?: readonly string[] };
    };
    if (e.type === "message_stop" && e.usage != null) {
      turns += 1;
      usage = {
        inputTokens: e.usage.inputTokens ?? 0,
        outputTokens: e.usage.outputTokens ?? 0,
        cacheReadInputTokens: e.usage.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: e.usage.cacheWriteInputTokens ?? 0,
      };
    } else if (e.type === "cache_miss") {
      for (const reason of e.payload?.changedComponents ?? []) {
        missReasons.add(reason);
      }
    }
  }
  return { ...usage, turns, missReasons: [...missReasons].sort() };
}

// ---------------------------------------------------------------------------
// Derived columns (single source for the formulas)
// ---------------------------------------------------------------------------

export function totalTokens(s: RunStats): number {
  return (
    s.inputTokens + s.outputTokens + s.cacheReadInputTokens + s.cacheWriteInputTokens
  );
}

/** Cache-read share of the input side — same formula as /cost and /status. */
export function cacheReadFraction(s: RunStats): number | undefined {
  const denom = s.cacheReadInputTokens + s.inputTokens;
  if (denom === 0) return undefined;
  return s.cacheReadInputTokens / denom;
}

/** Input-side tokens per turn — same formula as /cost's ctx/turn. */
export function ctxPerTurn(s: RunStats): number | undefined {
  if (s.turns === 0) return undefined;
  return Math.round(
    (s.inputTokens + s.cacheReadInputTokens + s.cacheWriteInputTokens) / s.turns,
  );
}

/** Honest $ via the canonical pricing table; undefined for unpriced models. */
export function runCostUsd(s: RunStats, model: string | undefined): number | undefined {
  if (model === undefined) return undefined;
  return new ApiCostModel().cost({
    model,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadInputTokens: s.cacheReadInputTokens,
    cacheWriteInputTokens: s.cacheWriteInputTokens,
  }).usd;
}

// ---------------------------------------------------------------------------
// Arm summary + comparison table
// ---------------------------------------------------------------------------

export interface ArmResult {
  readonly label: string;
  readonly runs: readonly RunStats[];
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function defined<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((v): v is T => v !== undefined);
}

function fmtPct(v: number | undefined): string {
  return v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

function fmtNum(v: number | undefined): string {
  if (v === undefined) return "—";
  return String(Math.round(v));
}

function fmtUsd(v: number | undefined): string {
  return v === undefined ? "n/a" : `$${v.toFixed(4)}`;
}

function fmtSecs(ms: number | undefined): string {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render per-run rows plus a mean line for one arm. Columns: total tokens,
 * fresh input, cache read/write, cache%, ctx/turn, $ (per --model), wall.
 */
export function formatArm(arm: ArmResult, model: string | undefined): string {
  const header = ["run", "total", "input", "cacheR", "cacheW", "cache%", "ctx/turn", "$", "wall"];
  const rows: string[][] = arm.runs.map((s, i) => [
    String(i + 1),
    fmtNum(totalTokens(s)),
    fmtNum(s.inputTokens),
    fmtNum(s.cacheReadInputTokens),
    fmtNum(s.cacheWriteInputTokens),
    fmtPct(cacheReadFraction(s)),
    fmtNum(ctxPerTurn(s)),
    fmtUsd(runCostUsd(s, model)),
    fmtSecs(s.wallClockMs),
  ]);
  rows.push([
    "mean",
    fmtNum(mean(arm.runs.map(totalTokens))),
    fmtNum(mean(arm.runs.map((s) => s.inputTokens))),
    fmtNum(mean(arm.runs.map((s) => s.cacheReadInputTokens))),
    fmtNum(mean(arm.runs.map((s) => s.cacheWriteInputTokens))),
    fmtPct(mean(defined(arm.runs.map(cacheReadFraction)))),
    fmtNum(mean(defined(arm.runs.map(ctxPerTurn)))),
    fmtUsd(mean(defined(arm.runs.map((s) => runCostUsd(s, model))))),
    fmtSecs(mean(defined(arm.runs.map((s) => s.wallClockMs)))),
  ]);
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => r[c]!.length)),
  );
  const fmtRow = (r: readonly string[]): string =>
    r.map((cell, c) => cell.padStart(widths[c]!)).join("  ");
  const reasons = [...new Set(arm.runs.flatMap((s) => s.missReasons))].sort();
  const reasonsLine =
    reasons.length > 0 ? `\n  attributed misses: ${reasons.join(", ")}` : "";
  return (
    `arm ${arm.label}\n  ` +
    fmtRow(header) +
    "\n  " +
    rows.map(fmtRow).join("\n  ") +
    reasonsLine
  );
}

/**
 * A→B delta line on the arm means. Positive % = B spends more. Cache% delta
 * is in percentage points.
 */
export function formatDelta(
  a: ArmResult,
  b: ArmResult,
  model: string | undefined,
): string {
  const pct = (av: number | undefined, bv: number | undefined): string => {
    if (av === undefined || bv === undefined || av === 0) return "—";
    return `${(((bv - av) / av) * 100).toFixed(1)}%`;
  };
  const totalA = mean(a.runs.map(totalTokens));
  const totalB = mean(b.runs.map(totalTokens));
  const cacheA = mean(defined(a.runs.map(cacheReadFraction)));
  const cacheB = mean(defined(b.runs.map(cacheReadFraction)));
  const cachePp =
    cacheA === undefined || cacheB === undefined
      ? "—"
      : `${((cacheB - cacheA) * 100).toFixed(1)}pp`;
  const usdA = mean(defined(a.runs.map((s) => runCostUsd(s, model))));
  const usdB = mean(defined(b.runs.map((s) => runCostUsd(s, model))));
  return `delta ${b.label} vs ${a.label} (means): total tokens ${pct(totalA, totalB)} · cache ${cachePp} · cost ${pct(usdA, usdB)}`;
}
