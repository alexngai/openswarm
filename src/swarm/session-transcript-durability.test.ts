/**
 * FX-JOURNAL-001..004 — a session transcript is append-only and survives a crash
 * (docs/63 `WP-07`).
 *
 * The transcript is the record of what happened in a session: what the operator
 * asked, what the agent did, which tools ran. Compaction reads it, resume reads
 * it, the trajectory provider reads it, and sessionlog turns it into training
 * attribution. It is the one artefact whose loss cannot be reconstructed from
 * anything else in the system.
 *
 * It was opened with `flags: "w"` and written through an unflushed stream.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { startSessionRecorder } from "./session-recorder.js";
import type { LaneEvent } from "./events.js";

let sessionsDir: string;
const dirs: string[] = [];

beforeEach(() => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-durable-"));
  dirs.push(sessionsDir);
  process.env.OPENSWARM_SESSION_DIR = sessionsDir;
  process.env.OPENSWARM_RECORD_SESSIONS = "1";
});

afterEach(async () => {
  delete process.env.OPENSWARM_SESSION_DIR;
  delete process.env.OPENSWARM_RECORD_SESSIONS;
  for (const d of dirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

const event = (type: string, payload: unknown): LaneEvent =>
  ({ ts: Date.now(), agentId: "a1", type, payload }) as unknown as LaneEvent;

function lines(sessionId: string): unknown[] {
  const raw = fs.readFileSync(path.join(sessionsDir, sessionId, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("FX-JOURNAL-001 a second turn does not erase the first", () => {
  it("keeps the earlier turn's events when a recorder reopens the session", async () => {
    // A long-lived worker records each turn under the same session id, and the
    // REPL reopens a session it is resuming. Opening for write truncated the
    // file, so every one of those wiped the history that came before it — the
    // transcript only ever held the most recent turn, and nothing reported the
    // loss because the write itself succeeded.
    const first = await startSessionRecorder({
      sessionId: "s1",
      agentId: "a1",
      prompt: "first turn",
      cwd: sessionsDir,
    });
    first!.record(event("tool_use_start", { name: "read_file" }));
    await first!.close();

    const second = await startSessionRecorder({
      sessionId: "s1",
      agentId: "a1",
      prompt: "second turn",
      cwd: sessionsDir,
    });
    second!.record(event("tool_use_start", { name: "write_file" }));
    await second!.close();

    const prompts = lines("s1")
      .filter((l) => (l as { type: string }).type === "turn_start")
      .map((l) => (l as { payload: { prompt: string } }).payload.prompt);

    expect(prompts).toEqual(["first turn", "second turn"]);
  });
});

describe("FX-JOURNAL-002 an event is on disk once it is recorded", () => {
  it("has flushed everything by the time close resolves", async () => {
    const rec = await startSessionRecorder({
      sessionId: "s2",
      agentId: "a1",
      prompt: "p",
      cwd: sessionsDir,
    });
    for (let i = 0; i < 50; i++) rec!.record(event("tool_use_start", { i }));
    await rec!.close();

    // 50 tool events plus the synthetic turn_start.
    expect(lines("s2")).toHaveLength(51);
  });

  it("leaves no partial line behind for a reader to choke on", async () => {
    const rec = await startSessionRecorder({
      sessionId: "s3",
      agentId: "a1",
      prompt: "p",
      cwd: sessionsDir,
    });
    rec!.record(event("tool_use_start", { name: "x" }));
    await rec!.close();

    const raw = fs.readFileSync(path.join(sessionsDir, "s3", "events.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("FX-JOURNAL-003 a torn trailing line is not a corrupt transcript", () => {
  it("reads every committed event and drops the interrupted one", async () => {
    const rec = await startSessionRecorder({
      sessionId: "s4",
      agentId: "a1",
      prompt: "p",
      cwd: sessionsDir,
    });
    rec!.record(event("tool_use_start", { name: "ok" }));
    await rec!.close();

    // A crash mid-append leaves bytes with no terminating newline. The caller
    // never learned the write happened, so it must not come back as an event —
    // but everything before it must.
    const file = path.join(sessionsDir, "s4", "events.jsonl");
    fs.appendFileSync(file, '{"ts":1,"agentId":"a1","type":"tool_use_st');

    const committed = fs
      .readFileSync(file, "utf8")
      .slice(0, fs.readFileSync(file, "utf8").lastIndexOf("\n"))
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(committed).toHaveLength(2);
    expect(() => committed.map((l) => JSON.parse(l))).not.toThrow();
  });
});

describe("FX-JOURNAL-004 two recorders on one session do not interleave lines", () => {
  it("writes whole lines even when turns overlap", async () => {
    // Two workers in the same team can record under one session id. A line
    // spliced into the middle of another is unparseable, and takes both events
    // with it rather than one.
    const a = await startSessionRecorder({
      sessionId: "s5",
      agentId: "a1",
      prompt: "worker a",
      cwd: sessionsDir,
    });
    const b = await startSessionRecorder({
      sessionId: "s5",
      agentId: "a2",
      prompt: "worker b",
      cwd: sessionsDir,
    });

    for (let i = 0; i < 40; i++) {
      a!.record(event("tool_use_start", { who: "a", i, pad: "x".repeat(200) }));
      b!.record(event("tool_use_start", { who: "b", i, pad: "y".repeat(200) }));
    }
    await Promise.all([a!.close(), b!.close()]);

    const parsed = lines("s5") as { payload?: { who?: string } }[];
    expect(parsed.filter((l) => l.payload?.who === "a")).toHaveLength(40);
    expect(parsed.filter((l) => l.payload?.who === "b")).toHaveLength(40);
  });
});
