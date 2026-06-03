import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { startSpineRecorder, acpEventsPath, acpSessionDir } from "./spine.js";
import type { LaneEvent } from "../swarm/events.js";
import type { AgentId } from "../core/types.js";

function fakeRunner() {
  let handler: ((e: LaneEvent) => void) | undefined;
  return {
    subscribeEvents: (h: (e: LaneEvent) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    emit: (e: LaneEvent) => handler?.(e),
    hasSubscriber: () => handler !== undefined,
  };
}

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readLines(sessionId: string): unknown[] {
  return fs
    .readFileSync(acpEventsPath(sessionId), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("startSpineRecorder", () => {
  it("writes a metadata header then recorded events, dropping live-only deltas", async () => {
    const sessionId = randomUUID();
    created.push(acpSessionDir(sessionId));
    const runner = fakeRunner();
    const rec = startSpineRecorder(runner);
    rec.start(sessionId);

    const L = "L" as AgentId;
    // Live-only — must be dropped.
    runner.emit({ ts: 1, agentId: L, type: "text_delta", payload: { type: "text_delta", text: "hi" } });
    // Recorded, attributed spine.
    runner.emit({ ts: 2, agentId: L, type: "worker_spawned", payload: { childAgentId: L } });
    runner.emit({ ts: 3, agentId: L, type: "tool_result", payload: { type: "tool_result", toolUseId: "t1", content: "x", isError: false } });
    runner.emit({ ts: 4, agentId: L, type: "message_stop", payload: { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });

    await rec.stop();

    const lines = readLines(sessionId);
    expect((lines[0] as { type?: string }).type).toBe("_metadata");
    expect((lines[0] as { producer?: string }).producer).toBe("acp-team");
    const types = lines.slice(1).map((e) => (e as { type: string }).type);
    expect(types).toEqual(["worker_spawned", "tool_result", "message_stop"]);
    // Attribution + timestamps preserved on the spine.
    expect((lines[1] as { agentId?: string; ts?: number }).agentId).toBe("L");
    expect((lines[1] as { ts?: number }).ts).toBe(2);
  });

  it("stop() detaches the lane subscription", async () => {
    const sessionId = randomUUID();
    created.push(acpSessionDir(sessionId));
    const runner = fakeRunner();
    const rec = startSpineRecorder(runner);
    rec.start(sessionId);
    expect(runner.hasSubscriber()).toBe(true);
    await rec.stop();
    expect(runner.hasSubscriber()).toBe(false);
  });

  it("a second start before stop is a no-op (single session per connection)", async () => {
    const first = randomUUID();
    const second = randomUUID();
    created.push(acpSessionDir(first), acpSessionDir(second));
    const runner = fakeRunner();
    const rec = startSpineRecorder(runner);
    rec.start(first);
    rec.start(second); // ignored
    await rec.stop();
    expect(fs.existsSync(acpEventsPath(first))).toBe(true);
    expect(fs.existsSync(acpEventsPath(second))).toBe(false);
  });
});
