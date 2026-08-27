/**
 * tool-input.ts — shared reassembly + parsing of streamed tool-call arguments.
 *
 * `tool_use_input` NormalizedEvents stream a tool call's arguments as
 * incremental JSON fragments between `tool_use_start` and `tool_use_end`.
 * Every consumer that wants the finished argument object has to (1) buffer the
 * fragments keyed by tool-call id and (2) JSON-parse the joined string at
 * end-of-call. This module is the single source of truth for both steps so the
 * headless JSONL emitter and the ACP translator can't drift apart.
 *
 * The repl-solid REPL intentionally does NOT use this: it forwards raw deltas
 * to its reducer, which accumulates in the UI store for live chip rendering
 * (see src/ui/repl-solid/tools/streaming.ts). Its display model (ReplEvent) is
 * unrelated to ACP's (SessionUpdate), so only this low-level assembly is shared.
 */

/** What to return when the buffer is empty or the JSON fails to parse. */
export type ToolInputFallback = "undefined" | "empty-object";

/**
 * Parse a joined tool-argument JSON string. Callers pick the fallback policy:
 * headless omits the `input` field entirely (⇒ `undefined`), ACP always wants
 * an object to derive locations/diffs/plan from (⇒ `{}`).
 */
export function parseToolInput(
  raw: string,
  fallback: ToolInputFallback = "undefined",
): unknown {
  const empty = fallback === "empty-object" ? {} : undefined;
  if (raw.trim().length === 0) return empty;
  try {
    return JSON.parse(raw);
  } catch {
    return empty;
  }
}

/**
 * Buffers streamed tool-argument fragments keyed by tool-call id, optionally
 * carrying a per-call metadata payload `M` (e.g. the tool name). One instance
 * is shared across an event stream; team paths prefix ids to stay unique.
 */
export class ToolInputAccumulator<M = void> {
  private readonly entries = new Map<string, { meta: M; parts: string[] }>();

  /** Begin a call (on `tool_use_start`). Overwrites any prior buffer for `id`. */
  start(id: string, meta: M): void {
    this.entries.set(id, { meta, parts: [] });
  }

  /**
   * Append a streamed fragment (on `tool_use_input`). Tolerates a missing
   * `start` by opening an entry with `undefined` metadata, mirroring the
   * lenient headless behavior.
   */
  append(id: string, jsonDelta: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      this.entries.set(id, { meta: undefined as M, parts: [jsonDelta] });
    } else {
      entry.parts.push(jsonDelta);
    }
  }

  /** True while a call is open (seen `start`/`append`, not yet `end`). */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Peek at the metadata for an open call without closing it. */
  meta(id: string): M | undefined {
    return this.entries.get(id)?.meta;
  }

  /**
   * Close a call (on `tool_use_end`) and return its metadata + joined raw JSON.
   * Returns `undefined` when no buffer exists for `id`.
   */
  end(id: string): { meta: M; raw: string } | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    this.entries.delete(id);
    return { meta: entry.meta, raw: entry.parts.join("") };
  }
}
