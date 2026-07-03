/**
 * Terminal formatter for a RichView (B2.2, docs/archive/35 §2) — pure: RichView -> lines.
 *
 * Renders the swarm-aware client's per-member lanes stacked with `[role]`
 * headers, each lane's narration + its tool calls (with a bounded inline diff
 * under edit/write calls), then the task board, then — when a `team_usage`
 * (#17) snapshot is supplied — a per-member token/cost ledger with a team total.
 * Kept dependency-free and side-effect-free so it's unit-tested directly; the
 * client binary just joins the lines and repaints.
 */

import type { RichView, RichLane, RichBoardEntry, RichDiff, RichTool } from "./rich-view.js";
import type { MemberUsageEntry, TeamUsagePayload } from "../swarm/events.js";

const STATUS_GLYPH: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  failed: "✗",
};

/** Max removed+added lines shown per tool's diff before truncating with `…`. */
const MAX_DIFF_SNIPPET_LINES = 6;

function glyph(status: string): string {
  return STATUS_GLYPH[status] ?? "·";
}

/** Compact token count, e.g. 17600 -> "17.6k", 940 -> "940". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Compact USD cost, e.g. 0.063 -> "$0.063", 1.5 -> "$1.50". */
function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 3)}`;
}

/** Split into lines, dropping a single trailing newline so it isn't counted. */
function diffLines(s: string): string[] {
  const t = s.endsWith("\n") ? s.slice(0, -1) : s;
  return t === "" ? [] : t.split("\n");
}

function laneHeader(lane: RichLane, usage?: MemberUsageEntry): string {
  const label = lane.role ?? lane.name ?? (lane.memberId || "orchestrator");
  const id = lane.memberId ? ` (${lane.memberId})` : "";
  const base = `── [${label}]${id} ${"─".repeat(Math.max(0, 32 - label.length - id.length))}`;
  return usage !== undefined
    ? `${base}  ${fmtTokens(usage.totalTokens)} tok · ${fmtCost(usage.costUsd)}`
    : base;
}

/**
 * A bounded unified-diff snippet for one tool's diffs: a `path +A -R` summary
 * line per diff, then removed (`- `) and added (`+ `) lines capped at
 * MAX_DIFF_SNIPPET_LINES. Empty diffs (no ± lines — e.g. an edit whose input
 * args weren't recorded) are skipped. Returned lines are unindented; the caller
 * indents them under the tool line.
 */
function formatToolDiffs(diffs: readonly RichDiff[]): string[] {
  const out: string[] = [];
  for (const d of diffs) {
    const removed = d.oldText === null ? [] : diffLines(d.oldText);
    const added = diffLines(d.newText);
    if (removed.length === 0 && added.length === 0) continue;
    out.push(`± ${d.path}  +${added.length} -${removed.length}`);
    let shown = 0;
    let truncated = false;
    for (const l of removed) {
      if (shown >= MAX_DIFF_SNIPPET_LINES) {
        truncated = true;
        break;
      }
      out.push(`- ${l}`);
      shown += 1;
    }
    for (const l of added) {
      if (shown >= MAX_DIFF_SNIPPET_LINES) {
        truncated = true;
        break;
      }
      out.push(`+ ${l}`);
      shown += 1;
    }
    if (truncated) out.push("…");
  }
  return out;
}

function formatTool(t: RichTool): string[] {
  const lines = [`  ${glyph(t.status)} ${t.title}`];
  if (t.diffs !== undefined) {
    for (const dl of formatToolDiffs(t.diffs)) lines.push(`      ${dl}`);
  }
  return lines;
}

function formatLane(lane: RichLane, usage?: MemberUsageEntry): string[] {
  const lines: string[] = [laneHeader(lane, usage)];
  const text = lane.text.trim();
  if (text.length > 0) {
    for (const l of text.split("\n")) lines.push(`  ${l}`);
  }
  for (const t of lane.tools) lines.push(...formatTool(t));
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

/**
 * Per-member token/cost ledger + a team total, from a `team_usage` (#17)
 * snapshot. Rendered as its own pane so the numbers are visible even for
 * members with no lane activity.
 */
function formatUsage(usage: TeamUsagePayload): string[] {
  const lines = ["── usage ───────────────────────"];
  for (const m of usage.members) {
    const label = m.role ?? m.memberId ?? m.agentId;
    const id = m.memberId ?? m.agentId;
    lines.push(
      `  [${label}] (${id})  ${fmtTokens(m.totalTokens)} tok · ${fmtCost(m.costUsd)}`,
    );
  }
  const t = usage.team;
  lines.push(`  Σ team  ${fmtTokens(t.totalTokens)} tok · ${fmtCost(t.costUsd)}`);
  return lines;
}

/** Index a usage snapshot by agentId and memberId so lanes can look up cost. */
function usageIndex(
  usage: TeamUsagePayload,
): Map<string, MemberUsageEntry> {
  const idx = new Map<string, MemberUsageEntry>();
  for (const m of usage.members) {
    idx.set(m.agentId, m);
    if (m.memberId !== undefined) idx.set(m.memberId, m);
  }
  return idx;
}

/**
 * Render a RichView as terminal lines: per-member lanes (each with its inline
 * diffs and, when `usage` is given, a token/cost suffix), the task board, then
 * a team-usage ledger.
 */
export function formatRichView(
  view: RichView,
  usage?: TeamUsagePayload,
): string[] {
  const out: string[] = [];
  const idx = usage !== undefined ? usageIndex(usage) : undefined;
  for (const lane of view.lanes) {
    out.push(...formatLane(lane, idx?.get(lane.memberId)));
    out.push("");
  }
  out.push(...formatBoard(view.board));
  if (usage !== undefined) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push(...formatUsage(usage));
  }
  return out;
}
