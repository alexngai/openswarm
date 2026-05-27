/**
 * team-watch.test.ts — formatter tests for v0.5 stage 5D MVP.
 *
 * The tail loop is structurally identical to team-logs (already tested).
 * These tests focus on the per-line formatter — color toggle, payload
 * summarisation, malformed-line passthrough.
 */

import { describe, it, expect } from "vitest";
import { formatLine } from "./team-watch.js";

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
