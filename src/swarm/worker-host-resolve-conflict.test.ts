import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { WorkerHost } from "./worker-host.js";
import type { ParentTransport } from "./ipc/parent-transport.js";
import type { AgentId, PermissionMode } from "../core/types.js";

function fakeTransport(send: ReturnType<typeof vi.fn>): ParentTransport {
  return Object.assign(new EventEmitter(), {
    send,
    notify: vi.fn(async () => {}),
    respond: vi.fn(),
    respondError: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    close: vi.fn(),
  }) as unknown as ParentTransport;
}

function makeHost(transport: ParentTransport): WorkerHost {
  return new WorkerHost(
    "agent-1" as AgentId,
    1,
    "workspace-write" as PermissionMode,
    transport,
  );
}

describe("WorkerHost.resolveConflict (docs/44 P2b)", () => {
  it("proxies via task.resolve_conflict and awaits the ack", async () => {
    const send = vi.fn(async () => null);
    const host = makeHost(fakeTransport(send));
    await host.resolveConflict("c1", { resolutionCommit: "abc" });
    expect(send).toHaveBeenCalledWith("task.resolve_conflict", {
      conflictId: "c1",
      resolutionCommit: "abc",
    });
  });

  it("omits resolutionCommit when not provided", async () => {
    const send = vi.fn(async () => null);
    const host = makeHost(fakeTransport(send));
    await host.resolveConflict("c2");
    expect(send).toHaveBeenCalledWith("task.resolve_conflict", {
      conflictId: "c2",
    });
  });
});
