/**
 * headless-prompt.ts — approval handler for `--headless` mode.
 *
 * Phase 2 design lock (doc 17 P2.Q4): same semantics as claw's piped-stdin
 * path (`input.rs:141-197`, `main.rs:7394-7404`).
 *   - Emit a `{"type":"permission_required", ...}` JSONL line on stdout so
 *     orchestrators know what to feed. Small deviation from claw (which
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

  const line = await readLine(input);
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

/**
 * Read a single line from the stream. Returns the line without the trailing
 * newline, or `null` on EOF.
 */
function readLine(stream: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let resolved = false;

    const done = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      resolve(value);
    };

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

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
