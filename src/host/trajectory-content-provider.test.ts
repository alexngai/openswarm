import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTrajectoryContent } from "./trajectory-content-provider.js";

afterEach(() => {
  delete process.env.SWARM_HARNESS_SESSION_DIR;
});

function seed(dir: string, sessionId: string, lines: object[]): void {
  const sd = path.join(dir, sessionId);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(
    path.join(sd, "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("resolveTrajectoryContent", () => {
  it("returns null when the session is not found", () => {
    process.env.SWARM_HARNESS_SESSION_DIR = path.join(os.tmpdir(), "no-such-xyz");
    expect(resolveTrajectoryContent("ghost")).toBeNull();
  });

  it("serves transcript + prompts + metadata for a recorded session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcp-"));
    process.env.SWARM_HARNESS_SESSION_DIR = dir;
    seed(dir, "s1", [
      { ts: 1, agentId: "a1", type: "turn_start", payload: { prompt: "do a thing" } },
      { ts: 2, agentId: "a1", type: "tool_use_start", payload: { id: "t1", name: "Write" } },
      { ts: 3, agentId: "a1", type: "text_delta", payload: { text: "done" } },
    ]);

    const c = resolveTrajectoryContent("s1");
    expect(c).not.toBeNull();
    expect(c!.checkpointId).toBe("s1");
    expect(c!.streaming).toBe(false);
    expect(c!.artifacts.prompts).toBe("do a thing");
    expect(c!.artifacts.transcript).toContain("turn_start");
    expect(c!.artifacts.metadata).toMatchObject({
      sessionId: "s1",
      turns: 1,
      toolCalls: 1,
      source: "swarm-harness",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
