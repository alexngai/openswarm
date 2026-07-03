import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startSessionRecorder,
  recordingEnabled,
  resolveSessionsDir,
  SkillUseTracker,
} from "./session-recorder.js";
import type { LaneEvent } from "./events.js";

afterEach(() => {
  delete process.env.OPENSWARM_SESSION_DIR;
  delete process.env.OPENSWARM_RECORD_SESSIONS;
});

describe("session recorder", () => {
  it("is disabled by default and returns null", async () => {
    expect(recordingEnabled()).toBe(false);
    expect(
      await startSessionRecorder({ sessionId: "s1", agentId: "a1", prompt: "hi" }),
    ).toBeNull();
  });

  it("enables via the record flag", () => {
    process.env.OPENSWARM_RECORD_SESSIONS = "1";
    expect(recordingEnabled()).toBe(true);
  });

  it("records the turn_start prompt + lane events to events.jsonl", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
    process.env.OPENSWARM_SESSION_DIR = dir;

    const rec = await startSessionRecorder({
      sessionId: "s1",
      agentId: "a1",
      prompt: "add a migration",
      cwd: dir, // not a sessionlog-enabled repo -> checkpointing no-ops
    });
    expect(rec).not.toBeNull();
    expect(rec!.transcriptPath).toBe(path.join(dir, "s1", "events.jsonl"));

    rec!.record({
      ts: 1,
      agentId: "a1",
      type: "text_delta",
      payload: { text: "ok" },
    } as LaneEvent);
    await rec!.close();

    const lines = fs
      .readFileSync(rec!.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      type: "turn_start",
      payload: { prompt: "add a migration" },
    });
    expect(lines[1]).toMatchObject({ type: "text_delta", payload: { text: "ok" } });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolveSessionsDir honors the env override and the default", () => {
    expect(resolveSessionsDir("/repo")).toBe(
      path.join("/repo", ".swarm", "openswarm", "sessions"),
    );
    process.env.OPENSWARM_SESSION_DIR = "/custom";
    expect(resolveSessionsDir("/repo")).toBe("/custom");
  });

  describe("SkillUseTracker", () => {
    const ev = (type: LaneEvent["type"], payload: unknown): LaneEvent =>
      ({ ts: 1, agentId: "a1", type, payload }) as LaneEvent;

    it("captures a skill tool invocation from streamed input deltas", () => {
      const t = new SkillUseTracker();
      t.observe(ev("tool_use_start", { id: "t1", name: "skill" }));
      t.observe(ev("tool_use_input", { id: "t1", jsonDelta: '{"id":"depl' }));
      t.observe(ev("tool_use_input", { id: "t1", jsonDelta: 'oy-web"}' }));
      t.observe(ev("tool_use_end", { id: "t1" }));
      t.observe(ev("tool_result", { toolUseId: "t1", content: "body", isError: false }));
      expect(t.used()).toEqual([{ name: "deploy-web" }]);
    });

    it("uses the full input from tool_use_end when present", () => {
      const t = new SkillUseTracker();
      t.observe(ev("tool_use_start", { id: "t1", name: "skill" }));
      t.observe(ev("tool_use_end", { id: "t1", input: { id: "tdd" } }));
      expect(t.used()).toEqual([{ name: "tdd" }]);
    });

    it("captures Claude Code's native Skill tool shape ({skill, args})", () => {
      const t = new SkillUseTracker();
      t.observe(ev("tool_use_start", { id: "t1", name: "Skill" }));
      t.observe(ev("tool_use_end", { id: "t1", input: { skill: "commit-helper", args: "-m x" } }));
      expect(t.used()).toEqual([{ name: "commit-helper", args: "-m x" }]);
    });

    it("handles typed lane payload keys (toolUseId/toolName/partialJson)", () => {
      const t = new SkillUseTracker();
      t.observe(ev("tool_use_start", { toolUseId: "t9", toolName: "skill" }));
      t.observe(ev("tool_use_input", { toolUseId: "t9", partialJson: '{"id":"x"}' }));
      t.observe(ev("tool_use_end", { toolUseId: "t9" }));
      expect(t.used()).toEqual([{ name: "x" }]);
    });

    it("ignores non-skill tools and drops errored invocations", () => {
      const t = new SkillUseTracker();
      // Different tool — never tracked.
      t.observe(ev("tool_use_start", { id: "t1", name: "bash" }));
      t.observe(ev("tool_use_end", { id: "t1", input: { id: "ls" } }));
      // Skill invocation whose load failed — dropped.
      t.observe(ev("tool_use_start", { id: "t2", name: "skill" }));
      t.observe(ev("tool_use_end", { id: "t2", input: { id: "missing-skill" } }));
      t.observe(ev("tool_result", { toolUseId: "t2", content: "not found", isError: true }));
      // Successful skill invocation.
      t.observe(ev("tool_use_start", { id: "t3", name: "skill" }));
      t.observe(ev("tool_use_end", { id: "t3", input: { id: "good-skill" } }));
      expect(t.used()).toEqual([{ name: "good-skill" }]);
    });

    it("tolerates malformed input JSON", () => {
      const t = new SkillUseTracker();
      t.observe(ev("tool_use_start", { id: "t1", name: "skill" }));
      t.observe(ev("tool_use_input", { id: "t1", jsonDelta: "{oops" }));
      t.observe(ev("tool_use_end", { id: "t1" }));
      expect(t.used()).toEqual([]);
    });
  });

  it("resolveSessionsDir prefers .openswarm when the migrated dir exists", () => {
    delete process.env.OPENSWARM_SESSION_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessdir-"));
    try {
      // No .openswarm dir yet → legacy .swarm default.
      expect(resolveSessionsDir(dir)).toBe(
        path.join(dir, ".swarm", "openswarm", "sessions"),
      );
      // Create the migrated layout → it takes precedence.
      const migrated = path.join(dir, ".openswarm", "openswarm", "sessions");
      fs.mkdirSync(migrated, { recursive: true });
      expect(resolveSessionsDir(dir)).toBe(migrated);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
