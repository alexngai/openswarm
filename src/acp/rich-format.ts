/**
 * Terminal formatter for a RichView (B2.2, docs/archive/35 §2) — pure: RichView -> lines.
 *
 * Renders the swarm-aware client's per-member lanes stacked with `[role]`
 * headers, each lane's narration + its tool calls, then the task board. Kept
 * dependency-free and side-effect-free so it's unit-tested directly; the client
 * binary just joins the lines and repaints.
 */

import type { RichView, RichLane, RichBoardEntry } from "./rich-view.js";

const STATUS_GLYPH: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  failed: "✗",
};

function glyph(status: string): string {
  return STATUS_GLYPH[status] ?? "·";
}

function laneHeader(lane: RichLane): string {
  const label = lane.role ?? lane.name ?? (lane.memberId || "orchestrator");
  const id = lane.memberId ? ` (${lane.memberId})` : "";
  return `── [${label}]${id} ${"─".repeat(Math.max(0, 32 - label.length - id.length))}`;
}

function formatLane(lane: RichLane): string[] {
  const lines: string[] = [laneHeader(lane)];
  const text = lane.text.trim();
  if (text.length > 0) {
    for (const l of text.split("\n")) lines.push(`  ${l}`);
  }
  for (const t of lane.tools) {
    lines.push(`  ${glyph(t.status)} ${t.title}`);
  }
  return lines;
}

function formatBoard(board: readonly RichBoardEntry[]): string[] {
  if (board.length === 0) return [];
  const lines = ["── board ───────────────────────"];
  for (const e of board) {
    const who = e.memberId ? ` (${e.memberId})` : "";
    lines.push(`  ${glyph(e.status)} ${e.content}${who}`);
  }
  return lines;
}

/** Render a RichView as terminal lines (lanes, then the task board). */
export function formatRichView(view: RichView): string[] {
  const out: string[] = [];
  for (const lane of view.lanes) {
    out.push(...formatLane(lane));
    out.push("");
  }
  out.push(...formatBoard(view.board));
  return out;
}
