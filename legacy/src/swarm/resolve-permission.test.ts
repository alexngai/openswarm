import { describe, it, expect, vi } from "vitest";
import { StandaloneHost } from "./standalone-host.js";
import { PermissionRequestParamsSchema } from "./ipc/protocol.js";

const req = {
  toolName: "bash",
  input: { command: "ls" },
  requiredPermission: "execute",
  currentMode: "read-only",
};

function laneEvents(host: StandaloneHost): string[] {
  const events: string[] = [];
  (host as unknown as { events: { on: (e: string, fn: (x: { type: string }) => void) => void } }).events.on(
    "lane_event",
    (e) => events.push(e.type),
  );
  return events;
}

describe("StandaloneHost.resolvePermission", () => {
  it("delegates to the interaction handler and emits prompt + granted", async () => {
    const requestPermission = vi.fn(async () => ({ outcome: "allow" as const, reason: "ok" }));
    const host = new StandaloneHost({ interactionHandler: { requestPermission } });
    const events = laneEvents(host);

    const decision = await host.resolvePermission(req);

    expect(decision).toEqual({ outcome: "allow", reason: "ok" });
    expect(requestPermission).toHaveBeenCalledWith(req);
    expect(events).toContain("permission_prompt");
    expect(events).toContain("permission_granted");
  });

  it("denies (and emits denied) when no handler is attached", async () => {
    const host = new StandaloneHost({});
    const events = laneEvents(host);

    const decision = await host.resolvePermission(req);

    expect(decision.outcome).toBe("deny");
    expect(events).toContain("permission_prompt");
    expect(events).toContain("permission_denied");
  });
});

describe("PermissionRequestParamsSchema", () => {
  it("accepts valid params, rejects a missing toolName", () => {
    expect(
      PermissionRequestParamsSchema.safeParse({
        toolName: "bash",
        requiredPermission: "x",
        currentMode: "y",
      }).success,
    ).toBe(true);
    expect(
      PermissionRequestParamsSchema.safeParse({
        requiredPermission: "x",
        currentMode: "y",
      }).success,
    ).toBe(false);
  });
});
