#!/usr/bin/env node
/**
 * gen-events.mjs — emit the curated `events.jsonl` that drives the
 * "see and steer your swarm" demo (demo/see-and-steer.tape).
 *
 * The team-daemon's per-team `events.jsonl` is the render contract for
 * `openswarm team watch <name>` (src/cli/team-watch.ts → parseTeamEventsLog →
 * lane-translator → RichRenderer). Because the board is a pure re-projection of
 * that file, we can drive the whole recording from a hand-authored log with NO
 * live model run and NO API spend — fully deterministic.
 *
 * Every record here matches the real LaneEvent wire shape (src/swarm/events.ts):
 *   { ts, agentId, type, payload, provenance? }
 * where for engine events (`text_delta` / `tool_use_*` / `tool_result` /
 * `message_stop`) `payload` IS the raw NormalizedEvent, exactly as the worker
 * forwards it on the lane bus (src/cli/worker-entry.ts).
 *
 * Fidelity note (#26): a real daemon's recorded events.jsonl NEVER contains
 * `tool_use_input` deltas — they're stripped as live-only at write time
 * (src/swarm/wire-protocol.ts). Instead, for edit/write tools the worker
 * attaches a bounded, secret-redacted `input` object directly on the recorded
 * `tool_use_end` (src/cli/worker-entry.ts → editInputForToolEnd), which is what
 * `team watch` reconstructs inline diffs from on replay (normalized-translate.ts
 * consumes `ne.input`; diffContent in tool-kind.ts turns it into a diff). This
 * fixture mirrors that exactly: no `tool_use_input` lines, and `input` on the
 * `tool_use_end` of edit tools only.
 *
 * Post-steer records are tagged `provenance: "steer"` so the player
 * (demo/play-events.mjs) can dribble the pre-steer arc first, then replay the
 * steer reaction when `openswarm team send …` is typed in the tape.
 *
 * Regenerate:  node demo/gen-events.mjs
 * Output:      demo/events/see-and-steer.events.jsonl
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "events", "see-and-steer.events.jsonl");

// Roster — agentId MUST equal the childAgentId on its worker_spawned event so
// the translator can resolve each event's [role] + lane via the roster.
const ORCH = "orchestrator";
const LEAD = "lead-01";
const ARCH = "arch-02";
const REV = "rev-03";
const IMPL = "impl-04";

let t = 1746318300000; // fixed epoch base → deterministic output
const step = () => (t += 1000);

const records = [];
const push = (r) => records.push(r);

/** Metadata header (wire-protocol.ts): first line of any daemon events.jsonl. */
const META = {
  type: "_metadata",
  protocol_version: "1.0",
  created_at: t,
  producer: "team-daemon",
};

// --- engine-event helpers (payload = raw NormalizedEvent) -------------------
const text = (agentId, s, steer) =>
  push({
    ts: step(),
    agentId,
    type: "text_delta",
    payload: { type: "text_delta", text: s },
    ...(steer ? { provenance: "steer" } : {}),
  });

const toolStart = (agentId, id, name, steer) =>
  push({
    ts: step(),
    agentId,
    type: "tool_use_start",
    payload: { type: "tool_use_start", id, name },
    ...(steer ? { provenance: "steer" } : {}),
  });

/** Edit/write family — the only tools that carry `input` on tool_use_end (#26). */
const EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "multi_edit",
  "apply_patch",
]);

// tool_use_end carries a bounded, redacted `input` for edit tools only (#26),
// exactly as src/cli/worker-entry.ts (editInputForToolEnd) records it. Non-edit
// tools forward with no `input` — there is no tool_use_input to fall back to.
const toolEnd = (agentId, id, name, input, steer) =>
  push({
    ts: step(),
    agentId,
    type: "tool_use_end",
    payload: {
      type: "tool_use_end",
      id,
      ...(EDIT_TOOLS.has(name) ? { input } : {}),
    },
    ...(steer ? { provenance: "steer" } : {}),
  });

const toolResult = (agentId, id, content, steer) =>
  push({
    ts: step(),
    agentId,
    type: "tool_result",
    payload: { type: "tool_result", toolUseId: id, content },
    ...(steer ? { provenance: "steer" } : {}),
  });

/**
 * A full tool call: start → end → result (✓). No tool_use_input line (stripped
 * as live-only by a real daemon). For edit tools, `input` rides on tool_use_end
 * so the board reconstructs the inline diff; for non-edit tools it's dropped.
 */
const tool = (agentId, id, name, input, result, steer) => {
  toolStart(agentId, id, name, steer);
  toolEnd(agentId, id, name, input, steer);
  toolResult(agentId, id, result, steer);
};

// --- lifecycle / coordination helpers (payload = free-form) -----------------
const spawned = (childAgentId, role) =>
  push({
    ts: step(),
    agentId: ORCH,
    type: "worker_spawned",
    payload: { childAgentId, role },
  });

const exited = (agentId, steer) =>
  push({
    ts: step(),
    agentId: ORCH,
    type: "worker_exited",
    payload: { agentId },
    ...(steer ? { provenance: "steer" } : {}),
  });

const teamEvt = (type, payload, steer) =>
  push({
    ts: step(),
    agentId: ORCH,
    type,
    payload,
    ...(steer ? { provenance: "steer" } : {}),
  });

// Real #17 usage roll-up (schema: TeamUsagePayload). Not yet surfaced by the
// terminal board formatter — included for fidelity + future renderers.
const usage = (members, teamTotals, steer) =>
  push({
    ts: step(),
    agentId: ORCH,
    type: "team_usage",
    payload: { members, team: teamTotals },
    ...(steer ? { provenance: "steer" } : {}),
  });

// ---------------------------------------------------------------------------
// PRE-STEER ARC — spawn the team, review the auth module.
// ---------------------------------------------------------------------------
teamEvt("team_started", { teamName: "review" });
spawned(LEAD, "lead");
spawned(ARCH, "architect");
spawned(REV, "reviewer");
spawned(IMPL, "implementer");

text(LEAD, "swarm online — reviewing the new auth module\n");

tool(ARCH, "t1", "read_file", { file_path: "src/auth/session.ts" }, "142 lines");
text(LEAD, "\u21b3 architect mapping the auth surface\n");
tool(ARCH, "t2", "grep", { pattern: "verifyToken" }, "3 matches in 2 files");
text(LEAD, "usage: 6.1k tok \u00b7 $0.02\n");

tool(
  IMPL,
  "t3",
  "edit_file",
  {
    file_path: "src/auth/session.ts",
    old_string: "const SESSION_TTL = 3600",
    new_string: "const SESSION_TTL = 900 // tighten session lifetime",
  },
  "1 edit applied",
);
text(LEAD, "\u21b3 implementer tightened session TTL (3600\u2192900s)\n");

tool(REV, "t4", "read_file", { file_path: "src/auth/session.ts" }, "142 lines");
tool(REV, "t5", "grep", { pattern: "TODO|FIXME" }, "1 match");
text(LEAD, "\u21b3 reviewer scanning for issues\n");
text(LEAD, "usage: 11.4k tok \u00b7 $0.04\n");

exited(ARCH);
exited(IMPL);
usage(
  [
    memberUsage(ARCH, "architect", 4200, 1800, 0.021),
    memberUsage(IMPL, "implementer", 5100, 2600, 0.028),
    memberUsage(REV, "reviewer", 1900, 700, 0.009),
    memberUsage(LEAD, "lead", 900, 400, 0.005),
  ],
  teamUsage(12100, 5500, 0.063),
);
text(LEAD, "architect + implementer done \u2713\n");

// ---------------------------------------------------------------------------
// STEER — operator sends "also check error handling"; team reacts.
// ---------------------------------------------------------------------------
const S = true;
text(LEAD, "\n\u25b8 steer received: also check error handling\n", S);
tool(REV, "t6", "grep", { pattern: "try|catch" }, "7 matches", S);
text(LEAD, "\u21b3 reviewer auditing error paths\n", S);
tool(
  IMPL,
  "t7",
  "edit_file",
  {
    file_path: "src/auth/session.ts",
    old_string: "return verify(token)",
    new_string:
      "try { return verify(token) } catch (e) { logAuthFailure(e); throw e }",
  },
  "1 edit applied",
  S,
);
text(LEAD, "\u21b3 implementer wrapped verify() in try/catch\n", S);
text(LEAD, "reviewer: error handling \u2713\n", S);
exited(REV, S);
exited(IMPL, S);
usage(
  [
    memberUsage(ARCH, "architect", 4200, 1800, 0.021),
    memberUsage(IMPL, "implementer", 7300, 3900, 0.041),
    memberUsage(REV, "reviewer", 3400, 1300, 0.017),
    memberUsage(LEAD, "lead", 1500, 700, 0.008),
  ],
  teamUsage(16400, 7700, 0.087),
  S,
);
text(LEAD, "usage: 15.8k tok \u00b7 $0.06 \u2014 review complete \u2713\n", S);
exited(LEAD, S);
teamEvt("team_completed", { teamName: "review", completion: "success" }, S);

// ---------------------------------------------------------------------------
function memberUsage(agentId, role, inTok, outTok, costUsd) {
  return {
    agentId,
    memberId: agentId,
    role,
    inputTokens: inTok,
    outputTokens: outTok,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: inTok + outTok,
    costUsd,
  };
}

function teamUsage(inTok, outTok, costUsd) {
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: inTok + outTok,
    costUsd,
  };
}

mkdirSync(dirname(OUT), { recursive: true });
const lines = [META, ...records].map((r) => JSON.stringify(r)).join("\n");
writeFileSync(OUT, lines + "\n", "utf8");
const steerCount = records.filter((r) => r.provenance === "steer").length;
process.stdout.write(
  `wrote ${records.length + 1} records (${records.length - steerCount} base + ${steerCount} steer + 1 meta) → ${OUT}\n`,
);
