/**
 * daemon-swarm-view.test.ts — GitHub #23.
 *
 * Proves the REPL attach path:
 *   1. (unit) DaemonSwarmViewProjector translates only the NEW tail of an
 *      events.jsonl blob into swarm-view NormalizedEvents, and its stateful
 *      translator persists members across ingests (cross-turn persistence).
 *   2. (integration) tailDaemonSwarmView follows a real file on disk, forwarding
 *      translated events to a sink as the daemon appends recorded lane events.
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DaemonSwarmViewProjector, tailDaemonSwarmView } from "./daemon-swarm-view.js";
import { buildMetadataEvent } from "./wire-protocol.js";
import type { LaneEvent } from "./events.js";
import type { AgentId, NormalizedEvent } from "../core/types.js";

let clock = 1;
function lane(type: string, agentId: string, payload: unknown): LaneEvent {
  return { ts: clock++, agentId: agentId as AgentId, type: type as LaneEvent["type"], payload };
}

/** Build an events.jsonl blob: metadata header + one line per lane event. */
function jsonl(events: readonly LaneEvent[]): string {
  const lines = [JSON.stringify(buildMetadataEvent("team-daemon"))];
  for (const e of events) lines.push(JSON.stringify(e));
  return lines.join("\n") + "\n";
}

describe("DaemonSwarmViewProjector", () => {
  it("translates a spawn+task_created blob into agent_spawned + task_update", () => {
    const p = new DaemonSwarmViewProjector();
    const out = p.ingest(
      jsonl([
        lane("worker_spawned", "orch", {
          childAgentId: "w1",
          parentAgentId: "orch",
          role: "executor",
          taskId: "t1",
        }),
        lane("task_created", "orch", { taskId: "t1", prompt: "Do the work" }),
      ]),
    );
    // Direct-orchestrator child renders as a tree root (no parentId): the daemon
    // orchestrator is never itself a worker_spawned member.
    expect(out).toContainEqual({
      type: "agent_spawned",
      agentId: "w1",
      name: "executor",
      role: "executor",
    });
    expect(out).toContainEqual({
      type: "task_update",
      taskId: "t1",
      title: "Do the work",
      status: "pending",
    });
  });

  it("only emits view events for the NEW tail on each ingest (no re-replay)", () => {
    const p = new DaemonSwarmViewProjector();
    const e1 = [lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "x", taskId: "t1" })];
    const first = p.ingest(jsonl(e1));
    expect(first.some((v) => v.type === "agent_spawned")).toBe(true);

    // Same content again → nothing new.
    expect(p.ingest(jsonl(e1))).toEqual([]);

    // Append a lifecycle change → only that projects.
    const e2 = [...e1, lane("worker_lifecycle_changed", "w1", { from: "spawning", to: "running" })];
    const second = p.ingest(jsonl(e2));
    expect(second).toEqual([
      { type: "agent_status", agentId: "w1", phase: "running", toolCount: 0, tokenUsage: 0 },
    ]);
  });

  it("persists members across ingests — a member from ingest 1 still projects in ingest 2 (cross-turn persistence)", () => {
    const p = new DaemonSwarmViewProjector();
    // Ingest 1: spawn a long-lived member.
    p.ingest(jsonl([lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "lead", taskId: "t1" })]));
    // Ingest 2 (a later "turn"): the member does work. Because the translator
    // is retained, it still recognizes w1 and emits its status.
    const later = p.ingest(
      jsonl([
        lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "lead", taskId: "t1" }),
        lane("tool_use_start", "w1", { toolUseId: "tu1", toolName: "bash" }),
      ]),
    );
    expect(later).toEqual([
      { type: "agent_status", agentId: "w1", phase: "running", toolCount: 1, tokenUsage: 0 },
    ]);
  });

  it("resets and replays when the file shrinks (rotation/truncation)", () => {
    const p = new DaemonSwarmViewProjector();
    p.ingest(jsonl([
      lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "x", taskId: "t1" }),
      lane("worker_lifecycle_changed", "w1", { from: "spawning", to: "running" }),
    ]));
    // Truncated to a single fresh spawn → projector rebuilds from scratch.
    const after = p.ingest(jsonl([
      lane("worker_spawned", "orch", { childAgentId: "w2", parentAgentId: "orch", role: "y", taskId: "t2" }),
    ]));
    expect(after.some((v) => v.type === "agent_spawned" && (v as { agentId: string }).agentId === "w2")).toBe(true);
  });
});

describe("tailDaemonSwarmView", () => {
  it("follows a real events.jsonl file and forwards translated events", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osw-attach-"));
    const eventsPath = path.join(dir, "events.jsonl");

    const received: NormalizedEvent[] = [];
    // Fast poll so the test doesn't linger.
    const unsub = tailDaemonSwarmView(eventsPath, (e) => received.push(e), { pollMs: 20 });

    try {
      // Daemon writes its header + a spawn.
      await fs.writeFile(
        eventsPath,
        jsonl([lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "executor", taskId: "t1" })]),
      );
      await waitFor(() => received.some((e) => e.type === "agent_spawned"));

      // Daemon appends a task_created + lifecycle change.
      await fs.appendFile(
        eventsPath,
        JSON.stringify(lane("task_created", "orch", { taskId: "t1", prompt: "Attach me" })) + "\n" +
          JSON.stringify(lane("worker_lifecycle_changed", "w1", { from: "spawning", to: "running" })) + "\n",
      );
      await waitFor(() =>
        received.some((e) => e.type === "task_update" && (e as { title?: string }).title === "Attach me"),
      );
      await waitFor(() =>
        received.some((e) => e.type === "agent_status" && (e as { phase?: string }).phase === "running"),
      );
    } finally {
      unsub();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
