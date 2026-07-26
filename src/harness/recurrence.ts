/**
 * Failure-recurrence tracking — the trigger for docs/63 P0 guards.
 *
 * The guard machinery (`./guards.ts`) is only reachable if the agent *notices*
 * it has repeated an avoidable failure and decides to install a guard. Nothing
 * makes that happen: it relies on the model spontaneously recognising a
 * pattern across many turns, which is the same compliance-under-generation-
 * pressure behaviour guards exist to fix. Left alone, the capability exists
 * but rarely fires.
 *
 * This closes that loop with the cheapest possible mechanism: count normalised
 * tool-failure signatures, and when one recurs, append a short in-band nudge
 * to the failing tool result. No engine changes, no extra model call — the
 * hint arrives exactly where and when the failure does.
 *
 * **What is deliberately NOT counted.** Only failures from `tool.execute()`
 * are observed. Both other error paths in `dispatch()` return *before* execute
 * and are therefore structurally excluded:
 *
 *   - **Guard blocks.** Counting them would be a feedback loop — a guard
 *     blocking a call would look like a recurring failure and prompt the agent
 *     to guard the guard.
 *   - **Schema-validation errors.** A guard cannot prevent one (validation
 *     runs first and rejects before guards), so nudging toward `define_guard`
 *     would be useless advice; the schema error message is already the fix.
 *
 * That leaves exactly the class guards help with: calls that were well-formed,
 * passed every existing check, and still failed against reality.
 */

// ---------------------------------------------------------------------------
// Signature derivation
// ---------------------------------------------------------------------------

const MAX_SIGNATURE_CHARS = 120;

/**
 * Normalise a tool error message into a stable signature so that the "same"
 * failure clusters across calls that differ only in incidental detail.
 *
 * Deliberately lossy and deterministic: absolute paths, numbers, quoted
 * strings, and hex blobs are replaced with placeholders. Two failures that
 * differ only by which file they touched share a signature — which is what we
 * want, since a guard would cover both.
 */
export function failureSignature(toolName: string, message: string): string {
  const normalized = message
    .toLowerCase()
    // Quoted strings first — they usually carry the incidental detail.
    .replace(/'[^']*'/g, "<str>")
    .replace(/"[^"]*"/g, "<str>")
    .replace(/`[^`]*`/g, "<str>")
    // Absolute and relative paths.
    .replace(/(?:\/[\w.\-@]+)+\/?/g, "<path>")
    // Hex blobs (hashes, ids) before plain numbers.
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SIGNATURE_CHARS);
  return `${toolName}:${normalized}`;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export interface RecurrenceObservation {
  readonly signature: string;
  readonly count: number;
  /** True exactly once per signature, on the call that reaches the threshold. */
  readonly shouldPrompt: boolean;
}

export interface RecurrenceEntry {
  readonly signature: string;
  readonly toolName: string;
  readonly count: number;
  /** A representative raw message, kept for the agent-facing nudge. */
  readonly sample: string;
  readonly prompted: boolean;
}

export interface FailureRecurrenceOptions {
  /**
   * Repeats required before nudging. Default 2 — the second occurrence is the
   * first moment a failure is demonstrably a *pattern* rather than bad luck,
   * and waiting longer wastes turns on a failure we could already prevent.
   */
  readonly threshold?: number;
}

export class FailureRecurrenceTracker {
  private readonly threshold: number;
  private readonly entries = new Map<
    string,
    { toolName: string; count: number; sample: string; prompted: boolean }
  >();

  constructor(options: FailureRecurrenceOptions = {}) {
    this.threshold = Math.max(2, options.threshold ?? 2);
  }

  /**
   * Record a post-execute tool failure. Returns whether this occurrence should
   * trigger a nudge — true at most once per signature, so an agent that
   * declines to install a guard is not nagged on every subsequent failure.
   * (If it keeps failing anyway, that is a finding for the eval, not something
   * to paper over with repetition.)
   */
  observe(toolName: string, message: string): RecurrenceObservation {
    const signature = failureSignature(toolName, message);
    const existing = this.entries.get(signature);
    if (existing === undefined) {
      this.entries.set(signature, {
        toolName,
        count: 1,
        sample: message,
        prompted: false,
      });
      return { signature, count: 1, shouldPrompt: false };
    }
    existing.count++;
    const shouldPrompt = !existing.prompted && existing.count >= this.threshold;
    if (shouldPrompt) existing.prompted = true;
    return { signature, count: existing.count, shouldPrompt };
  }

  /** Signatures seen so far, most frequent first. */
  list(): readonly RecurrenceEntry[] {
    return Array.from(this.entries.entries())
      .map(([signature, e]) => ({
        signature,
        toolName: e.toolName,
        count: e.count,
        sample: e.sample,
        prompted: e.prompted,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** Roll-up for the session record, alongside the guard summary. */
  summary(): {
    readonly distinctFailures: number;
    readonly repeatedFailures: number;
    readonly totalFailures: number;
    readonly prompted: number;
  } {
    let repeatedFailures = 0;
    let totalFailures = 0;
    let prompted = 0;
    for (const e of this.entries.values()) {
      totalFailures += e.count;
      if (e.count >= this.threshold) repeatedFailures++;
      if (e.prompted) prompted++;
    }
    return {
      distinctFailures: this.entries.size,
      repeatedFailures,
      totalFailures,
      prompted,
    };
  }
}

// ---------------------------------------------------------------------------
// The nudge
// ---------------------------------------------------------------------------

/**
 * The in-band hint appended to a repeated failure. Phrased as an observation
 * plus an option, not an instruction — the agent may have good reason to keep
 * going, and a guard that encodes a wrong rule is worse than none.
 *
 * Wrapped in `<system-reminder>` to match the convention used elsewhere for
 * harness-authored context (see docs/04 read_file / compaction reminders).
 */
export function recurrenceNudge(toolName: string, count: number): string {
  return (
    `\n\n<system-reminder>This ${toolName} call has now failed ${count} times ` +
    `in the same way this session. If the cause is a rule you keep having to ` +
    `remember rather than something you discovered, consider ` +
    `\`define_guard\` to make the mistake impossible for the rest of the ` +
    `session instead of relying on recall. Skip this if the repeats are ` +
    `incidental or the fix is a one-off.</system-reminder>`
  );
}
