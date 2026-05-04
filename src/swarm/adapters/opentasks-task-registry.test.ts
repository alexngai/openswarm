/**
 * Tests for OpenTasksTaskRegistry — v0.5 stage 5B.
 *
 * Uses a fake OpenTasksClient that records calls + lets tests inject
 * canned results, so the suite runs without a live daemon. Live
 * verification against a real opentasks daemon happens in the smoke
 * scripts when the daemon is reachable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AgentId } from "../../core/types.js";
import type { TaskAPI, TaskFilter, TaskPacket, TaskRecord } from "../host.js";
import {
  OpenTasksTaskRegistry,
} from "./opentasks-task-registry.js";
import type { OpenTasksClient, OpenTasksNode, CreateNodeParams, UpdateNodeParams } from "./opentasks-client.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeClient extends OpenTasksClient {
  readonly created: CreateNodeParams[];
  readonly updated: Array<{ id: string; updates: UpdateNodeParams }>;
}

function fakeClient(opts: { createReturns?: OpenTasksNode | null } = {}): FakeClient {
  const created: CreateNodeParams[] = [];
  const updated: Array<{ id: string; updates: UpdateNodeParams }> = [];
  let nodeCounter = 0;
  const client = {
    ping: async () => true,
    create: async (params: CreateNodeParams) => {
      created.push(params);
      if (opts.createReturns !== undefined) return opts.createReturns;
      nodeCounter++;
      return {
        id: `t-${nodeCounter}`,
        type: params.type,
        title: params.title,
        status: params.status,
      } satisfies OpenTasksNode;
    },
    update: async (id: string, updates: UpdateNodeParams) => {
      updated.push({ id, updates });
      return { id, type: "task", title: "x" } satisfies OpenTasksNode;
    },
    get: async () => null,
    query: async () => null,
    link: async () => null,
  } as unknown as FakeClient;
  // Augment with the inspector arrays.
  Object.defineProperty(client, "created", { value: created });
  Object.defineProperty(client, "updated", { value: updated });
  return client;
}

/**
 * Minimal in-memory TaskAPI that backs the test cases. Mirrors what
 * StandaloneHost wraps over TaskRegistry without pulling in the full host.
 *
 * `defaultScope` lets a test pin the scope the inner registry assigns —
 * mirrors how StandaloneHost would set scope from the team/host context.
 */
function inMemoryTaskApi(defaultScope = "swarm:default"): TaskAPI {
  const records = new Map<string, TaskRecord>();
  let counter = 0;
  return {
    create: async (packet: Omit<TaskPacket, "id">) => {
      counter++;
      const id = `local-${counter}`;
      const now = Date.now();
      const record = {
        ...packet,
        id,
        status: "pending" as const,
        createdAt: now,
        updatedAt: now,
        scope: defaultScope,
      } satisfies TaskRecord;
      records.set(id, record);
      return record;
    },
    get: async (id: string) => records.get(id),
    list: async (filter?: TaskFilter) => {
      let all = Array.from(records.values());
      if (filter?.scope !== undefined) all = all.filter((r) => r.scope === filter.scope);
      if (filter?.status !== undefined) all = all.filter((r) => r.status === filter.status);
      return all;
    },
    update: async (id: string, patch) => {
      const existing = records.get(id);
      if (!existing) throw new Error(`unknown id ${id}`);
      records.set(id, { ...existing, ...patch, updatedAt: Date.now() } as TaskRecord);
    },
    stop: async (id: string, by?: AgentId | "orchestrator") => {
      const existing = records.get(id);
      if (!existing) return;
      records.set(id, { ...existing, status: "stopped", stoppedBy: by, updatedAt: Date.now() } as TaskRecord);
    },
    ownerOf: async (id: string) => records.get(id)?.owner,
    appendOutput: () => {},
    output: () => (async function* () {})(),
  };
}

function basePacket(overrides: Partial<Omit<TaskPacket, "id">> = {}): Omit<TaskPacket, "id"> {
  return {
    prompt: "do the thing",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenTasksTaskRegistry", () => {
  let inner: TaskAPI;
  let client: FakeClient;
  let wrapper: OpenTasksTaskRegistry;

  beforeEach(() => {
    inner = inMemoryTaskApi();
    client = fakeClient();
    wrapper = new OpenTasksTaskRegistry(inner, client);
  });

  it("create() mirrors to opentasks with type=task + truncated title", async () => {
    // Re-bind inner with a non-default scope to verify metadata propagation.
    inner = inMemoryTaskApi("swarm:alpha");
    wrapper = new OpenTasksTaskRegistry(inner, client);
    const packet = basePacket({ prompt: "x".repeat(200) });
    const record = await wrapper.create(packet);

    // Local result is the inner registry's record.
    expect(record.id).toMatch(/^local-/);

    // Microtask drain — the mirror is fire-and-forget.
    await new Promise((r) => setImmediate(r));
    expect(client.created).toHaveLength(1);
    const c = client.created[0]!;
    expect(c.type).toBe("task");
    expect(c.title.length).toBe(80); // titleMaxLength default
    expect(c.content!.length).toBe(200); // full prompt preserved
    expect(c.metadata?.swarmTaskId).toBe(record.id);
    expect(c.metadata?.scope).toBe("swarm:alpha");
  });

  it("create() with empty prompt sends a placeholder title", async () => {
    const record = await wrapper.create(basePacket({ prompt: "" }));
    await new Promise((r) => setImmediate(r));
    expect(client.created[0]!.title).toBe("(empty prompt)");
    expect(record.id).toMatch(/^local-/);
  });

  it("update(status) mirrors a status patch when local id is mapped", async () => {
    const record = await wrapper.create(basePacket());
    await new Promise((r) => setImmediate(r));

    await wrapper.update(record.id, { status: "running" });
    await new Promise((r) => setImmediate(r));

    expect(client.updated).toHaveLength(1);
    expect(client.updated[0]!.updates.status).toBe("in_progress");
  });

  it("update(owner) mirrors as opentasks assignee", async () => {
    const record = await wrapper.create(basePacket());
    await new Promise((r) => setImmediate(r));

    await wrapper.update(record.id, { owner: "agent-7" as AgentId });
    await new Promise((r) => setImmediate(r));

    expect(client.updated[0]!.updates.assignee).toBe("agent-7");
  });

  it("update() does NOT mirror for fields opentasks doesn't model", async () => {
    const record = await wrapper.create(basePacket());
    await new Promise((r) => setImmediate(r));

    await wrapper.update(record.id, { output: "partial output" });
    await new Promise((r) => setImmediate(r));

    expect(client.updated).toHaveLength(0);
  });

  it("stop() mirrors as cancelled status with stoppedBy metadata", async () => {
    const record = await wrapper.create(basePacket());
    await new Promise((r) => setImmediate(r));

    await wrapper.stop(record.id, "agent-2" as AgentId);
    await new Promise((r) => setImmediate(r));

    expect(client.updated).toHaveLength(1);
    const u = client.updated[0]!.updates;
    expect(u.status).toBe("cancelled");
    expect(u.metadata?.stoppedBy).toBe("agent-2");
  });

  it("update() is silent when the create-mirror failed (no remoteId mapped)", async () => {
    // Use a client whose create returns null (e.g. daemon down).
    const badClient = fakeClient({ createReturns: null });
    wrapper = new OpenTasksTaskRegistry(inner, badClient);

    const record = await wrapper.create(basePacket());
    await new Promise((r) => setImmediate(r));
    await wrapper.update(record.id, { status: "succeeded" });
    await new Promise((r) => setImmediate(r));

    // No mapping → no update mirror call.
    expect(badClient.updated).toHaveLength(0);
    expect(wrapper.remoteIdOf(record.id)).toBeUndefined();
  });

  it("read-only ops delegate straight to the inner TaskAPI", async () => {
    const r1 = await wrapper.create(basePacket({ prompt: "first" }));
    const r2 = await wrapper.create(basePacket({ prompt: "second" }));

    expect(await wrapper.get(r1.id)).toMatchObject({ id: r1.id });
    const list = await wrapper.list();
    expect(list).toHaveLength(2);
    void r2;
  });
});
