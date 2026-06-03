import { describe, it, expect } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  swarmMemberMeta,
  withSwarmMeta,
  SWARM_META_VERSION,
} from "./swarm-meta.js";
import { emitNormalizedEvent, type EmitOptions } from "./normalized-translate.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";

function member(role: string, agentId: string): MemberInfo {
  return {
    memberId: `m-${agentId}`,
    role,
    agentId: agentId as AgentId,
    state: "running",
    handle: {} as MemberInfo["handle"],
  };
}

describe("swarmMemberMeta", () => {
  it("builds v1 member meta from a roster entry; omits task without a taskId", () => {
    const meta = swarmMemberMeta(member("architect", "W"));
    expect(meta).toEqual({
      v: SWARM_META_VERSION,
      member: { id: "m-W", name: "architect", role: "architect" },
    });
    expect(meta).not.toHaveProperty("task");
  });

  it("includes task context (id/topology/parent/deps) when provided", () => {
    const meta = swarmMemberMeta(member("lead", "L"), {
      topology: "coordinator",
      taskId: "t-1",
      parentTaskId: "t-0",
      dependsOn: ["t-2"],
    });
    expect(meta.task).toEqual({
      id: "t-1",
      parentId: "t-0",
      dependsOn: ["t-2"],
      topology: "coordinator",
    });
  });

  it("omits empty dependsOn rather than emitting an empty array", () => {
    const meta = swarmMemberMeta(member("lead", "L"), { taskId: "t-1", dependsOn: [] });
    expect(meta.task).toEqual({ id: "t-1" });
  });
});

describe("withSwarmMeta", () => {
  it("is a no-op when meta is undefined (baseline stays byte-identical)", () => {
    const update = { sessionUpdate: "agent_message_chunk" } as SessionUpdate;
    expect(withSwarmMeta(update, undefined)).toBe(update);
  });

  it("attaches _meta.swarm and preserves any existing _meta keys", () => {
    const update = {
      sessionUpdate: "agent_message_chunk",
      _meta: { other: 1 },
    } as unknown as SessionUpdate;
    const meta = swarmMemberMeta(member("lead", "L"));
    const out = withSwarmMeta(update, meta) as unknown as {
      _meta: { other: number; swarm: unknown };
    };
    expect(out._meta.other).toBe(1);
    expect(out._meta.swarm).toEqual(meta);
  });
});

describe("emitNormalizedEvent — _meta.swarm plumbing (B1.0)", () => {
  function collect(): { updates: SessionUpdate[]; opts: Omit<EmitOptions, "meta"> } {
    const updates: SessionUpdate[] = [];
    return {
      updates,
      opts: {
        send: async (u) => {
          updates.push(u);
        },
        open: new Map(),
      },
    };
  }

  it("attaches the same _meta.swarm to every update when meta is set", async () => {
    const { updates, opts } = collect();
    const meta = swarmMemberMeta(member("architect", "W"), { topology: "coordinator" });
    await emitNormalizedEvent(
      { type: "text_delta", text: "hi" },
      { ...opts, meta },
    );
    await emitNormalizedEvent(
      { type: "tool_use_start", id: "t1", name: "read_file" },
      { ...opts, meta },
    );
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect((u as { _meta?: { swarm?: unknown } })._meta?.swarm).toEqual(meta);
    }
  });

  it("emits no _meta when meta is unset (baseline)", async () => {
    const { updates, opts } = collect();
    await emitNormalizedEvent({ type: "text_delta", text: "hi" }, opts);
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("_meta");
  });
});
