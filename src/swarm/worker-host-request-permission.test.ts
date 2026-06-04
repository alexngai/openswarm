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

const req = {
  toolName: "bash",
  input: { command: "rm -rf x" },
  requiredPermission: "danger",
  currentMode: "read-only",
};

describe("WorkerHost.requestPermission", () => {
  it("sends a permission.request and returns the orchestrator's decision", async () => {
    const send = vi.fn(async () => ({ outcome: "allow", reason: "ok" }));
    const host = makeHost(fakeTransport(send));
    const res = await host.requestPermission(req);
    expect(res).toEqual({ outcome: "allow", reason: "ok" });
    expect(send).toHaveBeenCalledWith(
      "permission.request",
      expect.objectContaining({ toolName: "bash", requiredPermission: "danger" }),
      expect.anything(),
    );
  });

  it("denies on transport error (safe default)", async () => {
    const send = vi.fn(async () => {
      throw new Error("transport_closed: boom");
    });
    const host = makeHost(fakeTransport(send));
    const res = await host.requestPermission(req);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toContain("boom");
  });
});
