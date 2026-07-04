/**
 * transcript-export.ts — serialize the transcript to plain text (doc 49 Phase C1).
 *
 * Used by the Ctrl+R "dump conversation" action in app.tsx: the text is pushed
 * into the terminal's native scrollback (searchable with the terminal's own
 * find / tmux copy-mode) and saved to a temp file as a durable artifact.
 *
 * Plain text only — no ANSI, no OpenTUI primitives — so it round-trips cleanly
 * through scrollback, files, and pipes.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry, ToolCallState } from "../repl/state.js";
import { getRenderer } from "./tools/registry.js";

function serializeTool(
  entry: TranscriptEntry,
  toolCalls: Readonly<Record<string, ToolCallState>>,
): string[] {
  const tc = entry.toolCallId !== undefined ? toolCalls[entry.toolCallId] : undefined;
  if (tc === undefined) {
    const name = entry.tool?.name ?? "tool";
    const summary = entry.tool?.summary ?? entry.text;
    return [summary.length > 0 ? `● ${name} — ${summary}` : `● ${name}`];
  }
  const r = getRenderer(tc.name);
  const status = tc.isError ? "✗" : "✓";
  const keyArg = r.keyArg(tc);
  const chip = r.chip(tc);
  const header = ["●", tc.name, keyArg, chip].filter((s) => s.length > 0).join(" ");
  const lines = [`${status} ${header}`];
  for (const bl of r.bodyLines(tc)) lines.push(`    ${bl}`);
  return lines;
}

/**
 * Render the transcript as a plain-text conversation log. Entries are separated
 * by blank lines; tool calls include their expanded body for a complete record.
 */
export function serializeTranscript(
  entries: readonly TranscriptEntry[],
  toolCalls: Readonly<Record<string, ToolCallState>> = {},
): string {
  const out: string[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case "user":
        out.push(`> ${e.text}`);
        break;
      case "assistant":
        out.push(e.text);
        break;
      case "system":
        out.push(`· ${e.text}`);
        break;
      case "tool":
        out.push(...serializeTool(e, toolCalls));
        break;
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** Write serialized transcript text to a timestamped temp file; returns its path. */
export function saveTranscript(text: string): string {
  const file = join(tmpdir(), `openswarm-transcript-${Date.now()}.txt`);
  writeFileSync(file, text, "utf-8");
  return file;
}
