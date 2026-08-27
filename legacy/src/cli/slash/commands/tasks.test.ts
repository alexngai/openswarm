import { describe, it, expect } from "vitest";
import { tasksCommand } from "./tasks.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";
import type { SwarmHost, TaskRecord } from "../../../swarm/host.js";

function makeHost(records: readonly TaskRecord[]): SwarmHost {
  return {
    mode: "standalone",
    kind: "standalone",
    agentId: "root" as SwarmHost["agentId"],
    depth: 0,
    permissionMode: "workspace-write",
    emit: () => undefined,
    spawn: () => {
      throw new Error("not used");
    },
    isAncestorOf: () => Promise.resolve(true),
    send: (): never => {
      throw new Error("not used");
    },
    inbox: () => {
      throw new Error("not used");
    },
    drainInbox: async () => [],
    commitChanges: async () => null,
    askUser: (): never => {
      throw new Error("M3b Phase 6 — not yet implemented");
    },
    task: {
      create: () => {
        throw new Error("not used");
      },
      get: () => Promise.resolve(undefined),
      list: () => Promise.resolve(records),
      update: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      ownerOf: () => Promise.resolve(undefined),
      appendOutput: () => undefined,
      output: () => {
        throw new Error("not used");
      },
      pullNext: () => Promise.resolve(null),
    },
  };
}

describe("/tasks", () => {
  it("reports absence of a host", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await tasksCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("not yet wired");
    }
  });

  it("reports 'no tasks' when the host returns an empty list", async () => {
    const host = makeHost([]);
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      { host },
    );
    const res = await tasksCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toBe("no tasks");
    }
  });

  it("lists id/status/subject rows when tasks are present", async () => {
    const now = Date.now();
    const host = makeHost([
      {
        id: "t1",
        prompt: "do the thing",
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
        status: "running",
        createdAt: now,
        updatedAt: now,
        scope: "swarm:default",
      },
    ]);
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      { host },
    );
    const res = await tasksCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("t1");
      expect(res.text).toContain("running");
      expect(res.text).toContain("do the thing");
    }
  });
});
