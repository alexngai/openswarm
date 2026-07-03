/**
 * team-watch.test.ts — formatter tests for v0.5 stage 5D MVP.
 *
 * The tail loop is structurally identical to team-logs (already tested).
 * These tests focus on the per-line formatter — color toggle, payload
 * summarisation, malformed-line passthrough.
 */

import { describe, it, expect } from "vitest";
import { formatLine, renderEventLogBoard } from "./team-watch.js";
import type { LaneEvent } from "../swarm/events.js";
import type { AgentId } from "../core/types.js";

const noColorFmt = {
  header: (s: string) => s,
  dim: (s: string) => s,
  type: (s: string) => s,
  error: (s: string) => s,
  message: (s: string) => s,
  agent: (s: string) => s,
};

describe("formatLine", () => {
  it("emits ts + type + agent prefix + summary for a typical event", () => {
    const event = {
      ts: 1746318300000,
      type: "team_started",
      agentId: "abcdef0123456789",
      payload: { teamName: "alpha" },
    };
    const out = formatLine(JSON.stringify(event), noColorFmt);
    expect(out).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d/);
    expect(out).toContain("team_started");
    expect(out).toContain("abcdef01"); // 8-char agentId prefix
    expect(out).toContain("alpha");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("summarises message_sent with the content field (truncated)", () => {
    const event = {
      ts: 1,
      type: "message_sent",
      agentId: "a1b2c3d4e5",
      payload: { from: "x", to: "y", content: "hello world from x to y" },
    };
    const out = formatLine(JSON.stringify(event), noColorFmt);
    expect(out).toContain("hello world from x to y");
    expect(out).toContain("message_sent");
  });

  it("passes malformed JSON through verbatim", () => {
    const out = formatLine("not-json{", noColorFmt);
    expect(out).toBe("not-json{\n");
  });

  it("renders missing ts as placeholder", () => {
    const event = { type: "team_note", payload: { note: "x" } };
    const out = formatLine(JSON.stringify(event), noColorFmt);
    expect(out).toContain("--:--:--.---");
  });

  it("dashes the agent prefix when agentId is missing", () => {
    const event = { ts: 1, type: "team_started", payload: { teamName: "z" } };
    const out = formatLine(JSON.stringify(event), noColorFmt);
    expect(out).toContain("--------");
  });

  it("truncates long content to keep one-line layout", () => {
    const longContent = "x".repeat(500);
    const event = {
      ts: 1,
      type: "message_sent",
      agentId: "abcd",
      payload: { content: longContent },
    };
    const out = formatLine(JSON.stringify(event), noColorFmt);
    expect(out.length).toBeLessThan(300);
    expect(out).toContain("…");
  });

  it("colorises errors when a color formatter is supplied", () => {
    const colorFmt = {
      header: (s: string) => `[H]${s}[/H]`,
      dim: (s: string) => `[D]${s}[/D]`,
      type: (s: string) => `[T]${s}[/T]`,
      error: (s: string) => `[E]${s}[/E]`,
      message: (s: string) => `[M]${s}[/M]`,
      agent: (s: string) => `[A]${s}[/A]`,
    };
    const event = {
      ts: 1,
      type: "team_aborted",
      agentId: "abcdef01",
      payload: { reason: "boom" },
    };
    const out = formatLine(JSON.stringify(event), colorFmt);
    expect(out).toContain("[E]team_aborted[/E]");
    expect(out).toContain("[A]abcdef01[/A]");
  });
});

// ---------------------------------------------------------------------------
// Multi-pane board (issue #16)
// ---------------------------------------------------------------------------

const L = "L" as AgentId;
const A = "A" as AgentId;
const ORCH = "orch" as AgentId;

const spawned = (childAgentId: string, role: string): LaneEvent =>
  ({
    ts: 1,
    agentId: ORCH,
    type: "worker_spawned",
    payload: { childAgentId, role },
  }) as LaneEvent;

const toolStart = (
  agentId: AgentId,
  id: string,
  name: string,
  ts: number,
): LaneEvent =>
  ({
    ts,
    agentId,
    type: "tool_use_start",
    payload: { type: "tool_use_start", id, name },
  }) as LaneEvent;

const toolEnd = (
  agentId: AgentId,
  id: string,
  ts: number,
  input?: unknown,
): LaneEvent =>
  ({
    ts,
    agentId,
    type: "tool_use_end",
    payload: { type: "tool_use_end", id, ...(input !== undefined ? { input } : {}) },
  }) as LaneEvent;

describe("renderEventLogBoard", () => {
  it("renders one lane per active member with [role]-attributed tools", async () => {
    const events: LaneEvent[] = [
      spawned("L", "lead"),
      spawned("A", "architect"),
      toolStart(L, "t1", "read_file", 3),
      toolEnd(L, "t1", 4),
      toolStart(A, "t2", "write_file", 5),
      toolEnd(A, "t2", 6),
    ];
    const text = (await renderEventLogBoard(events)).join("\n");
    // A lane header per member (role-labeled).
    expect(text).toContain("[lead]");
    expect(text).toContain("[architect]");
    // Tool calls surface in their member's lane, [role]-prefixed.
    expect(text).toContain("[lead] Read file");
    expect(text).toContain("[architect] Write file");
  });

  it("renders a task board listing every roster member's state", async () => {
    const events: LaneEvent[] = [spawned("L", "lead"), spawned("A", "architect")];
    const lines = await renderEventLogBoard(events);
    const text = lines.join("\n");
    // Board pane present with both members even before any tool activity.
    expect(text).toContain("board");
    expect(lines.some((l) => l.includes("lead") && l.includes("(L)"))).toBe(true);
    expect(
      lines.some((l) => l.includes("architect") && l.includes("(A)")),
    ).toBe(true);
  });

  it("returns an empty view for an empty event stream", async () => {
    const lines = await renderEventLogBoard([]);
    expect(lines).toEqual([]);
  });

  const toolInput = (
    agentId: AgentId,
    id: string,
    jsonDelta: string,
    ts: number,
  ): LaneEvent =>
    ({
      ts,
      agentId,
      type: "tool_use_input",
      payload: { type: "tool_use_input", id, jsonDelta },
    }) as LaneEvent;

  it("renders an inline diff for an edit tool call from recorded input", async () => {
    const I = "I" as AgentId;
    const events: LaneEvent[] = [
      spawned("I", "implementer"),
      toolStart(I, "t3", "edit_file", 3),
      toolInput(
        I,
        "t3",
        JSON.stringify({
          file_path: "src/auth/session.ts",
          old_string: "const SESSION_TTL = 3600",
          new_string: "const SESSION_TTL = 900",
        }),
        4,
      ),
      toolEnd(I, "t3", 5),
    ];
    const text = (await renderEventLogBoard(events)).join("\n");
    expect(text).toContain("[implementer] Edit src/auth/session.ts");
    expect(text).toContain("± src/auth/session.ts  +1 -1");
    expect(text).toContain("- const SESSION_TTL = 3600");
    expect(text).toContain("+ const SESSION_TTL = 900");
  });

  it("renders an inline diff from a recorded tool_use_end `input` with NO tool_use_input line (issue #26 live/replay guard)", async () => {
    const I = "I" as AgentId;
    // Mirrors the recorded team wire: tool_use_input is stripped as live-only,
    // so the diff must reconstruct purely from the `input` carried on
    // tool_use_end.
    const events: LaneEvent[] = [
      spawned("I", "implementer"),
      toolStart(I, "t9", "edit_file", 3),
      toolEnd(I, "t9", 5, {
        file_path: "src/auth/session.ts",
        old_string: "const SESSION_TTL = 3600",
        new_string: "const SESSION_TTL = 900",
      }),
    ];
    const text = (await renderEventLogBoard(events)).join("\n");
    expect(text).toContain("[implementer] Edit src/auth/session.ts");
    expect(text).toContain("± src/auth/session.ts  +1 -1");
    expect(text).toContain("- const SESSION_TTL = 3600");
    expect(text).toContain("+ const SESSION_TTL = 900");
  });

  it("renders per-member cost and a team total from a team_usage event", async () => {
    const usage: LaneEvent = {
      ts: 10,
      agentId: ORCH,
      type: "team_usage",
      payload: {
        members: [
          {
            agentId: "A",
            memberId: "A",
            role: "architect",
            inputTokens: 4200,
            outputTokens: 1800,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: 6000,
            costUsd: 0.021,
          },
        ],
        team: {
          inputTokens: 4200,
          outputTokens: 1800,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 6000,
          costUsd: 0.021,
        },
      },
    } as LaneEvent;
    const events: LaneEvent[] = [
      spawned("A", "architect"),
      toolStart(A, "t1", "read_file", 3),
      toolEnd(A, "t1", 4),
      usage,
    ];
    const text = (await renderEventLogBoard(events)).join("\n");
    // Per-member cost suffix on the architect lane header.
    expect(text).toMatch(/\[architect\].*6\.0k tok · \$0\.021/);
    // Usage ledger + team total.
    expect(text).toContain("── usage");
    expect(text).toContain("Σ team  6.0k tok · $0.021");
  });

  it("uses the latest team_usage snapshot when several are present", async () => {
    const mk = (total: number, cost: number): LaneEvent =>
      ({
        ts: total,
        agentId: ORCH,
        type: "team_usage",
        payload: {
          members: [],
          team: {
            inputTokens: total,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: total,
            costUsd: cost,
          },
        },
      }) as LaneEvent;
    const events: LaneEvent[] = [spawned("A", "architect"), mk(6000, 0.021), mk(17600, 0.063)];
    const text = (await renderEventLogBoard(events)).join("\n");
    expect(text).toContain("Σ team  17.6k tok · $0.063");
    expect(text).not.toContain("$0.021");
  });
});
