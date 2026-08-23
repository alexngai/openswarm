/**
 * headless-prompt.ts — approval handler for `--headless` mode.
 *
 * Phase 2 design lock (doc 17 P2.Q4): same semantics as the reference implementation's piped-stdin
 * path.
 *   - Emit a `{"type":"permission_required", ...}` JSONL line on stdout so
 *     orchestrators know what to feed. Small deviation from the reference implementation (which
 *     prints plain text) — JSONL is our existing headless stream format.
 *   - Block on stdin for one line.
 *   - "y" / "yes" (case-insensitive, trimmed) → approve.
 *   - "a" / "always" → approve + session-scoped allow rule (Phase 3 B4).
 *   - EOF, empty line, or anything else → deny.
 */

import type { PendingPermission } from "../ui/repl/state.js";
import type { BridgeDecision } from "./bridge.js";

export interface HeadlessPromptOptions {
  /** Output stream for the JSONL event. Default: process.stdout. */
  readonly out?: NodeJS.WritableStream;
  /** Input stream to read the user's answer. Default: process.stdin. */
  readonly in?: NodeJS.ReadableStream;
  /**
   * Stop waiting when this aborts, and deny.
   *
   * An orchestrator driving a headless run answers promptly or not at all, so
   * the case this covers is nobody being there — stdin open, no line coming.
   * Detaching matters as much as denying: a listener left on stdin would
   * consume the line meant for the next question (docs/67 WP-09).
   */
  readonly signal?: AbortSignal;
}

/**
 * Emit a `permission_required` JSONL line then block on stdin for the answer.
 * Resolves with the PermissionDecision.
 */
export async function readHeadlessApproval(
  pending: PendingPermission,
  opts: HeadlessPromptOptions = {},
): Promise<BridgeDecision> {
  const out = opts.out ?? process.stdout;
  const input = opts.in ?? process.stdin;

  const payload = {
    type: "permission_required",
    tool: pending.toolName,
    input: pending.input,
    currentMode: pending.currentMode,
    requiredPermission: pending.requiredPermission,
    ...(pending.reason !== undefined && { reason: pending.reason }),
  };
  out.write(JSON.stringify(payload) + "\n");

  const line = await readLine(input, opts.signal);
  if (line === ABANDONED) {
    return {
      allow: false,
      reason: `denied ${pending.toolName}: no answer arrived before the request expired`,
    };
  }
  const normalized = (line ?? "").trim().toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return { allow: true };
  }
  if (normalized === "a" || normalized === "always") {
    return { allow: true, alwaysAllow: true };
  }
  return {
    allow: false,
    reason:
      line === null
        ? `user denied ${pending.toolName}: stdin EOF`
        : `user denied ${pending.toolName}: answered "${normalized || "<empty>"}"`,
  };
}

/** Distinguishes "we stopped waiting" from EOF and from an empty line. */
const ABANDONED = Symbol("headless approval abandoned");

type Line = string | null | typeof ABANDONED;

/**
 * A line reader that owns the stream instead of borrowing it per question.
 *
 * Reading a line per approval with a fresh listener set looks equivalent and is
 * not, in two ways that only appear once a run asks twice.
 *
 * An orchestrator answering a batch writes "n\ny\n" in one go, and a reader whose
 * buffer is local to the call keeps the first line and drops the rest — so the
 * second question is answered by nothing. And a stream that has already ended
 * does not re-emit `end` to a listener attached afterwards, so the second read
 * never settles at all. That is worse than the hang it looks like: with stdin
 * closed there is nothing left holding the event loop, so the process exits 0
 * with the turn unfinished, and whoever is driving it reads that as success.
 *
 * So the buffer and the ended flag live with the stream, and a read after end
 * answers immediately (docs/67 `WP-09`).
 */
interface LineSource {
  read(signal?: AbortSignal): Promise<Line>;
}

const sources = new WeakMap<NodeJS.ReadableStream, LineSource>();

function lineSource(stream: NodeJS.ReadableStream): LineSource {
  const existing = sources.get(stream);
  if (existing !== undefined) return existing;

  let buffer = "";
  let ended = false;
  const waiting: ((value: Line) => void)[] = [];

  /** The next complete line, or null once the stream is done producing them. */
  const take = (): { got: true; line: Line } | { got: false } => {
    const nl = buffer.indexOf("\n");
    if (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      return { got: true, line };
    }
    if (ended) {
      // A trailing line with no newline still counts; after that, EOF.
      const rest = buffer;
      buffer = "";
      return { got: true, line: rest.length > 0 ? rest : null };
    }
    return { got: false };
  };

  const pump = (): void => {
    while (waiting.length > 0) {
      const next = take();
      if (!next.got) return;
      waiting.shift()!(next.line);
    }
  };

  stream.on("data", (chunk: unknown) => {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Buffer
          ? chunk.toString("utf8")
          : String(chunk);
    pump();
  });
  stream.on("end", () => {
    ended = true;
    pump();
  });
  stream.on("error", () => {
    ended = true;
    pump();
  });

  const source: LineSource = {
    read(signal?: AbortSignal): Promise<Line> {
      if (signal?.aborted === true) return Promise.resolve(ABANDONED);

      const ready = take();
      if (ready.got) return Promise.resolve(ready.line);

      return new Promise<Line>((resolve) => {
        let settled = false;
        const settle = (value: Line): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          const at = waiting.indexOf(settle);
          if (at !== -1) waiting.splice(at, 1);
          resolve(value);
        };
        function onAbort(): void {
          settle(ABANDONED);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.push(settle);
      });
    },
  };

  sources.set(stream, source);
  return source;
}

/**
 * Read a single line from the stream. Returns the line without the trailing
 * newline, `null` on EOF, or `ABANDONED` if `signal` fired first.
 */
function readLine(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Line> {
  return lineSource(stream).read(signal);
}
