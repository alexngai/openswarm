import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startSessionRecorder,
  recordingEnabled,
  resolveSessionsDir,
} from "./session-recorder.js";
import type { LaneEvent } from "./events.js";

afterEach(() => {
  delete process.env.SWARM_HARNESS_SESSION_DIR;
  delete process.env.SWARM_HARNESS_RECORD_SESSIONS;
});

describe("session recorder", () => {
  it("is disabled by default and returns null", () => {
    expect(recordingEnabled()).toBe(false);
    expect(
      startSessionRecorder({ sessionId: "s1", agentId: "a1", prompt: "hi" }),
    ).toBeNull();
  });

  it("enables via the record flag", () => {
    process.env.SWARM_HARNESS_RECORD_SESSIONS = "1";
    expect(recordingEnabled()).toBe(true);
  });

  it("records the turn_start prompt + lane events to events.jsonl", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
    process.env.SWARM_HARNESS_SESSION_DIR = dir;

    const rec = startSessionRecorder({
      sessionId: "s1",
      agentId: "a1",
      prompt: "add a migration",
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
      path.join("/repo", ".swarm", "swarm-harness", "sessions"),
    );
    process.env.SWARM_HARNESS_SESSION_DIR = "/custom";
    expect(resolveSessionsDir("/repo")).toBe("/custom");
  });
});
