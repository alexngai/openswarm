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
   * consume the line meant for the next question (docs/63 WP-09).
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

/**
 * Read a single line from the stream. Returns the line without the trailing
 * newline, `null` on EOF, or `ABANDONED` if `signal` fired first.
 */
function readLine(
  stream: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<string | null | typeof ABANDONED> {
  return new Promise((resolve) => {
    let buffer = "";
    let resolved = false;

    const done = (value: string | null | typeof ABANDONED): void => {
      if (resolved) return;
      resolved = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const onAbort = (): void => done(ABANDONED);

    const onData = (chunk: unknown): void => {
      // Chunk may be Buffer or string depending on encoding.
      const text =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Buffer
            ? chunk.toString("utf8")
            : String(chunk);
      buffer += text;
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        done(buffer.slice(0, nl));
      }
    };

    const onEnd = (): void => {
      done(buffer.length > 0 ? buffer : null);
    };

    const onError = (): void => {
      done(null);
    };

    if (signal?.aborted === true) {
      resolve(ABANDONED);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
