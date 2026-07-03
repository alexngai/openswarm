/**
 * swarm-views.test.tsx — GitHub #15.
 *
 * End-to-end (no test-only dispatch): drives real swarm lane events through
 * the production SwarmViewTranslator, reduces the resulting NormalizedEvents
 * into ReplState exactly as the App event pump does, and asserts the AgentTree
 * (Ctrl+A) and TaskBoard (Ctrl+T) views render the live member + task data.
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { AgentTree } from "./views/agent-tree.js";
import { TaskBoard } from "./views/task-board.js";
import { SwarmViewTranslator } from "../../swarm/swarm-view-events.js";
import { reduce, createInitialState, type ReplEvent, type ReplState } from "../repl/state.js";
import type { LaneEvent } from "../../swarm/events.js";
import type { NormalizedEvent, AgentId } from "../../core/types.js";

function lane(type: string, agentId: string, payload: unknown): LaneEvent {
  return { ts: 1, agentId: agentId as AgentId, type: type as LaneEvent["type"], payload };
}

/**
 * Mirror the three swarm cases of translateEngineEvent (app.tsx L507-536) so
 * the test exercises the same NormalizedEvent → ReplEvent mapping the running
 * REPL uses.
 */
function toReplEvents(evt: NormalizedEvent): ReplEvent[] {
  switch (evt.type) {
    case "agent_spawned":
      return [{ type: "agent-spawned", id: evt.agentId, name: evt.name, role: evt.role, parentId: evt.parentId }];
    case "agent_status":
      return [{ type: "agent-status", id: evt.agentId, phase: evt.phase, toolCount: evt.toolCount, tokenUsage: evt.tokenUsage }];
    case "task_update":
      return [{ type: "task-update", id: evt.taskId, title: evt.title, status: evt.status, assignee: evt.assignee }];
    default:
      return [];
  }
}

/** Feed lane events through the translator + reducer, returning final state. */
function stateFromLaneEvents(laneEvents: LaneEvent[], orchestratorId: string): ReplState {
  const translator = new SwarmViewTranslator({
    orchestratorId: orchestratorId as AgentId,
    resolveTaskTitle: (id) => (id === "t1" ? "Refactor the parser" : undefined),
  });
  let state = createInitialState();
  for (const le of laneEvents) {
    for (const ne of translator.onLaneEvent(le)) {
      for (const re of toReplEvents(ne)) state = reduce(state, re);
    }
  }
  return state;
}

const ORCH = "orch";

const liveSwarm: LaneEvent[] = [
  lane("worker_spawned", ORCH, { childAgentId: "w1", parentAgentId: ORCH, role: "researcher", taskId: "t1" }),
  lane("worker_lifecycle_changed", "w1", { from: "spawning", to: "running" }),
  lane("tool_use_start", "w1", { type: "tool_use_start", id: "tu1", name: "grep" }),
];

describe("swarm views populate from live translator output", () => {
  it("AgentTree renders the spawned member with its role", async () => {
    const state = stateFromLaneEvents(liveSwarm, ORCH);
    // Sanity: producer populated the store (not a test-only dispatch).
    expect(Object.keys(state.agents)).toContain("w1");
    expect(state.agents["w1"]!.phase).toBe("running");
    expect(state.agents["w1"]!.toolCount).toBe(1);

    const { captureCharFrame, renderOnce } = await testRender(
      () => <AgentTree agents={state.agents} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("researcher");
  });

  it("TaskBoard renders the member's task, transitioning active → done", async () => {
    const withExit = [
      ...liveSwarm,
      lane("worker_exited", ORCH, { agentId: "w1", exitCode: 0 }),
    ];
    const state = stateFromLaneEvents(withExit, ORCH);
    expect(state.tasks["t1"]).toBeDefined();
    expect(state.tasks["t1"]!.title).toBe("Refactor the parser");
    expect(state.tasks["t1"]!.status).toBe("done");
    expect(state.agents["w1"]!.phase).toBe("done");

    const { captureCharFrame, renderOnce } = await testRender(
      () => <TaskBoard tasks={state.tasks} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Refactor the parser");
    // done status icon.
    expect(frame).toContain("✓");
  });
});
