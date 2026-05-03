/**
 * map-adapter.test.ts — verify lane-event → MAP-event translation, scope
 * derivation, subscription/teardown, and unmapped-event filtering.
 *
 * Uses a fake `MapClientFactory` so no real ws:// server is required. The
 * adapter is wired against a minimal stub host that exposes the same private
 * `events` EventEmitter shape `peer-team.ts` reads from.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { MapAdapter } from "./map-adapter.js";
import type {
  MapAgentConnectOptions,
  MapAgentConnection,
  MapClientFactory,
} from "./map-protocol.js";
import type { LaneEvent } from "../events.js";
import type { StandaloneHost } from "../standalone-host.js";
import type { AgentId } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeMapClient implements MapAgentConnection {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly sends: Array<{ method: string; params: unknown }> = [];
  closed = false;

  async send(method: string, params: unknown): Promise<void> {
    this.sends.push({ method, params });
  }
  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeFactory implements MapClientFactory {
  readonly clients: FakeMapClient[] = [];
  readonly connectOpts: MapAgentConnectOptions[] = [];

  async connect(opts: MapAgentConnectOptions): Promise<MapAgentConnection> {
    this.connectOpts.push(opts);
    const c = new FakeMapClient();
    this.clients.push(c);
    return c;
  }
}

/**
 * Stub host: only the `events` field is exercised by MapAdapter.start()/stop().
 * Cast to `StandaloneHost` is safe because the adapter accesses the host
 * exclusively through the documented `events` EventEmitter shape.
 */
function makeStubHost(): { host: StandaloneHost; events: EventEmitter } {
  const events = new EventEmitter();
  return {
    host: { events } as unknown as StandaloneHost,
    events,
  };
}

function emit(events: EventEmitter, event: LaneEvent): void {
  events.emit("lane_event", event);
}

const AGENT_ID = "agent-1" as AgentId;

function makeEvent(
  type: LaneEvent["type"],
  payload: unknown = {},
): LaneEvent {
  return {
    ts: 0,
    agentId: AGENT_ID,
    type,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MapAdapter", () => {
  let factory: FakeFactory;

  beforeEach(() => {
    factory = new FakeFactory();
  });

  it("happy path: a lane event forwards as a MAP notification with scope", async () => {
    const { host, events } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://test:8080",
      teamName: "alpha",
      factory,
      scope: "swarm:alpha:fixed",
    });
    await adapter.start(host);

    emit(
      events,
      makeEvent("worker_spawned", {
        childAgentId: "child-1",
        role: "executor",
        taskId: "task-1",
      }),
    );

    expect(factory.clients).toHaveLength(1);
    const client = factory.clients[0]!;
    expect(client.notifications).toHaveLength(1);
    const note = client.notifications[0]!;
    expect(note.method).toBe("swarm.agent.spawned");
    expect(note.params).toMatchObject({
      childAgentId: "child-1",
      role: "executor",
      taskId: "task-1",
      scope: "swarm:alpha:fixed",
    });

    await adapter.stop();
  });

  it("each mapping table entry produces the right MAP method", async () => {
    const { host, events } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "t",
      factory,
      scope: "swarm:t:0",
    });
    await adapter.start(host);

    const cases: Array<{
      lane: LaneEvent;
      expected: string;
    }> = [
      {
        lane: makeEvent("worker_spawned", { childAgentId: "c" }),
        expected: "swarm.agent.spawned",
      },
      {
        lane: makeEvent("worker_exited", { exitCode: 0 }),
        expected: "swarm.agent.completed",
      },
      {
        lane: makeEvent("worker_exited", { exitCode: 1 }),
        expected: "swarm.agent.failed",
      },
      {
        lane: makeEvent("task_created", { taskId: "t1" }),
        expected: "swarm.task.dispatched",
      },
      {
        lane: makeEvent("task_updated", { taskId: "t1" }),
        expected: "swarm.task.updated",
      },
      {
        lane: makeEvent("task_completed", { taskId: "t1" }),
        expected: "swarm.task.completed",
      },
      {
        lane: makeEvent("message_sent", { from: "a", to: "b" }),
        expected: "swarm.message.sent",
      },
      {
        lane: makeEvent("branch_lock_acquired", { branch: "main" }),
        expected: "swarm.branch.locked",
      },
      {
        lane: makeEvent("branch_lock_released", { branch: "main" }),
        expected: "swarm.branch.released",
      },
      {
        lane: makeEvent("team_started", { teamName: "t" }),
        expected: "swarm.team.started",
      },
      {
        lane: makeEvent("team_completed", { teamName: "t" }),
        expected: "swarm.team.completed",
      },
      {
        lane: makeEvent("team_aborted", { teamName: "t" }),
        expected: "swarm.team.aborted",
      },
    ];

    for (const c of cases) {
      emit(events, c.lane);
    }

    const client = factory.clients[0]!;
    expect(client.notifications.map((n) => n.method)).toEqual(
      cases.map((c) => c.expected),
    );
    // Every payload includes scope.
    for (const n of client.notifications) {
      expect((n.params as { scope: string }).scope).toBe("swarm:t:0");
    }

    await adapter.stop();
  });

  it("worker_exited with no exitCode is treated as success", async () => {
    const { host, events } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "t",
      factory,
    });
    await adapter.start(host);

    emit(events, makeEvent("worker_exited", {}));

    const client = factory.clients[0]!;
    expect(client.notifications).toHaveLength(1);
    expect(client.notifications[0]!.method).toBe("swarm.agent.completed");

    await adapter.stop();
  });

  it("unmapped events are not forwarded", async () => {
    const { host, events } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "t",
      factory,
    });
    await adapter.start(host);

    emit(events, makeEvent("text_delta", { text: "hi" }));
    emit(events, makeEvent("turn_start", {}));
    emit(events, makeEvent("tool_use_start", { toolUseId: "x", toolName: "y" }));
    emit(events, makeEvent("heartbeat", {}));

    const client = factory.clients[0]!;
    expect(client.notifications).toHaveLength(0);

    await adapter.stop();
  });

  it("default scope derivation is swarm:<teamName>:<pid>", async () => {
    const { host } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "alpha",
      factory,
    });
    await adapter.start(host);

    expect(adapter.scope).toBe(`swarm:alpha:${process.pid}`);
    expect(factory.connectOpts[0]!.scope).toBe(`swarm:alpha:${process.pid}`);

    await adapter.stop();
  });

  it("scope override is honored", async () => {
    const { host } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "ignored",
      factory,
      scope: "custom-scope",
    });
    await adapter.start(host);

    expect(adapter.scope).toBe("custom-scope");
    expect(factory.connectOpts[0]!.scope).toBe("custom-scope");

    await adapter.stop();
  });

  it("connect options carry agentInfo and capabilities", async () => {
    const { host } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t:9",
      teamName: "alpha",
      factory,
      agentName: "custom-name",
    });
    await adapter.start(host);

    const opts = factory.connectOpts[0]!;
    expect(opts.url).toBe("ws://t:9");
    expect(opts.agentInfo).toEqual({
      name: "custom-name",
      role: "orchestrator",
    });
    expect(opts.capabilities).toEqual({ swarm: true });

    await adapter.stop();
  });

  it("stop() closes the connection and unsubscribes", async () => {
    const { host, events } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "t",
      factory,
    });
    await adapter.start(host);
    expect(events.listenerCount("lane_event")).toBe(1);

    await adapter.stop();
    const client = factory.clients[0]!;
    expect(client.closed).toBe(true);
    expect(events.listenerCount("lane_event")).toBe(0);

    // Subsequent emits are dropped silently.
    emit(events, makeEvent("worker_spawned", {}));
    expect(client.notifications).toHaveLength(0);
  });

  it("stop() swallows close() errors so a hung MAP server can't fail the run", async () => {
    class BrokenClient extends FakeMapClient {
      override async close(): Promise<void> {
        throw new Error("ECONNRESET");
      }
    }
    class BrokenFactory implements MapClientFactory {
      async connect(): Promise<MapAgentConnection> {
        return new BrokenClient();
      }
    }
    const { host } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "t",
      factory: new BrokenFactory(),
    });
    await adapter.start(host);
    // Should not throw.
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it("start() is idempotent (a second call is a no-op)", async () => {
    const { host } = makeStubHost();
    const adapter = new MapAdapter({
      url: "ws://t",
      teamName: "t",
      factory,
    });
    await adapter.start(host);
    await adapter.start(host);

    expect(factory.clients).toHaveLength(1);
    await adapter.stop();
  });
});
