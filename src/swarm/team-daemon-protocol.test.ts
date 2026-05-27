/**
 * Tests for src/swarm/team-daemon-protocol.ts — v0.5 stage 5E.1.
 *
 * Locks the wire shape: type guards, schema accept/reject, JSON round-trip.
 * Transport tests live in 5E.2.
 */

import { describe, it, expect } from "vitest";
import {
  isRequest,
  isResponse,
  isNotification,
  StatusParamsSchema,
  StatusResultSchema,
  SendPromptParamsSchema,
  SendPromptResultSchema,
  StopParamsSchema,
  KillParamsSchema,
  AcknowledgedResultSchema,
  TeamEventParamsSchema,
  TEAM_DAEMON_ERROR_CODES,
  type TeamDaemonFrame,
} from "./team-daemon-protocol.js";

describe("team-daemon-protocol — type guards", () => {
  it('isRequest narrows kind="request"', () => {
    const f: TeamDaemonFrame = {
      kind: "request",
      id: "1",
      method: "status",
      params: {},
    };
    expect(isRequest(f)).toBe(true);
    expect(isResponse(f)).toBe(false);
    expect(isNotification(f)).toBe(false);
  });

  it('isResponse narrows kind="response" (ok and err)', () => {
    const ok: TeamDaemonFrame = {
      kind: "response",
      id: "1",
      ok: true,
      result: {},
    };
    const err: TeamDaemonFrame = {
      kind: "response",
      id: "1",
      ok: false,
      error: { code: "x", message: "y" },
    };
    expect(isResponse(ok)).toBe(true);
    expect(isResponse(err)).toBe(true);
    expect(isRequest(ok)).toBe(false);
    expect(isNotification(ok)).toBe(false);
  });

  it('isNotification narrows kind="notification"', () => {
    const f: TeamDaemonFrame = {
      kind: "notification",
      method: "team_event",
      params: { ts: 1 },
    };
    expect(isNotification(f)).toBe(true);
    expect(isRequest(f)).toBe(false);
    expect(isResponse(f)).toBe(false);
  });
});

describe("team-daemon-protocol — request schemas", () => {
  it("StatusParamsSchema requires strictly-empty object", () => {
    expect(StatusParamsSchema.safeParse({}).success).toBe(true);
    expect(StatusParamsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("SendPromptParamsSchema accepts prompt + each target variant", () => {
    expect(SendPromptParamsSchema.safeParse({ prompt: "hi" }).success).toBe(
      true,
    );
    expect(
      SendPromptParamsSchema.safeParse({ prompt: "hi", target: "entry" })
        .success,
    ).toBe(true);
    expect(
      SendPromptParamsSchema.safeParse({ prompt: "hi", target: "broadcast" })
        .success,
    ).toBe(true);
    expect(
      SendPromptParamsSchema.safeParse({
        prompt: "hi",
        target: { agentId: "a-1" },
      }).success,
    ).toBe(true);
  });

  it("SendPromptParamsSchema rejects empty prompt + invalid target", () => {
    expect(SendPromptParamsSchema.safeParse({ prompt: "" }).success).toBe(
      false,
    );
    expect(
      SendPromptParamsSchema.safeParse({ prompt: "hi", target: "bogus" })
        .success,
    ).toBe(false);
    expect(
      SendPromptParamsSchema.safeParse({
        prompt: "hi",
        target: { wrong: "key" },
      }).success,
    ).toBe(false);
  });

  it("StopParamsSchema accepts optional timeoutMs (positive int)", () => {
    expect(StopParamsSchema.safeParse({}).success).toBe(true);
    expect(StopParamsSchema.safeParse({ timeoutMs: 1000 }).success).toBe(true);
    expect(StopParamsSchema.safeParse({ timeoutMs: -1 }).success).toBe(false);
    expect(StopParamsSchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
  });

  it("KillParamsSchema requires strictly-empty object", () => {
    expect(KillParamsSchema.safeParse({}).success).toBe(true);
    expect(KillParamsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("team-daemon-protocol — result schemas", () => {
  it("StatusResultSchema accepts a complete team snapshot", () => {
    const result = StatusResultSchema.safeParse({
      teamName: "gsd",
      scope: "swarm:gsd",
      topology: "peer-team",
      startedAt: 1746000000000,
      members: [
        {
          memberId: "m-1",
          role: "architect",
          agentId: "a-1",
          state: "running",
        },
        { memberId: "m-2", role: "executor", agentId: "a-2", state: "idle" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("StatusResultSchema rejects missing required fields", () => {
    expect(
      StatusResultSchema.safeParse({
        teamName: "gsd",
        scope: "swarm:gsd",
        topology: "peer-team",
        // startedAt missing
        members: [],
      }).success,
    ).toBe(false);
  });

  it("SendPromptResultSchema requires non-negative delivered + recipients[]", () => {
    expect(
      SendPromptResultSchema.safeParse({ delivered: 0, recipients: [] }).success,
    ).toBe(true);
    expect(
      SendPromptResultSchema.safeParse({
        delivered: 3,
        recipients: ["a", "b", "c"],
      }).success,
    ).toBe(true);
    expect(
      SendPromptResultSchema.safeParse({ delivered: -1, recipients: [] }).success,
    ).toBe(false);
  });

  it("AcknowledgedResultSchema requires acknowledged: true literal", () => {
    expect(
      AcknowledgedResultSchema.safeParse({ acknowledged: true }).success,
    ).toBe(true);
    expect(
      AcknowledgedResultSchema.safeParse({ acknowledged: false }).success,
    ).toBe(false);
  });
});

describe("team-daemon-protocol — notifications + errors", () => {
  it("TeamEventParamsSchema accepts a LaneEvent-shaped object via passthrough", () => {
    const result = TeamEventParamsSchema.safeParse({
      ts: 1746000000000,
      agentId: "a-1",
      type: "worker_spawned",
      payload: { foo: "bar" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // passthrough preserves unknown fields
      expect(result.data).toMatchObject({
        ts: 1746000000000,
        agentId: "a-1",
        type: "worker_spawned",
      });
    }
  });

  it("TeamEventParamsSchema rejects missing ts", () => {
    expect(
      TeamEventParamsSchema.safeParse({ agentId: "a-1", type: "x" }).success,
    ).toBe(false);
  });

  it("TEAM_DAEMON_ERROR_CODES exposes the v0.5-specific codes", () => {
    expect(TEAM_DAEMON_ERROR_CODES.TEAM_NOT_RUNNING).toBe("team_not_running");
    expect(TEAM_DAEMON_ERROR_CODES.TEAM_ALREADY_RUNNING).toBe(
      "team_already_running",
    );
    expect(TEAM_DAEMON_ERROR_CODES.TRANSPORT_CLOSED).toBe("transport_closed");
  });
});

describe("team-daemon-protocol — JSON round-trip", () => {
  it("request frame round-trips through JSON.stringify/parse", () => {
    const req: TeamDaemonFrame = {
      kind: "request",
      id: "rpc-1",
      method: "send_prompt",
      params: { prompt: "review HEAD", target: "entry" },
    };
    const round = JSON.parse(JSON.stringify(req)) as TeamDaemonFrame;
    expect(round).toEqual(req);
    expect(isRequest(round)).toBe(true);
  });

  it("response frame round-trips (ok)", () => {
    const resp: TeamDaemonFrame = {
      kind: "response",
      id: "rpc-1",
      ok: true,
      result: { delivered: 3, recipients: ["a", "b", "c"] },
    };
    const round = JSON.parse(JSON.stringify(resp)) as TeamDaemonFrame;
    expect(round).toEqual(resp);
    expect(isResponse(round)).toBe(true);
  });

  it("response frame round-trips (err)", () => {
    const resp: TeamDaemonFrame = {
      kind: "response",
      id: "rpc-1",
      ok: false,
      error: { code: TEAM_DAEMON_ERROR_CODES.UNKNOWN_METHOD, message: "no" },
    };
    const round = JSON.parse(JSON.stringify(resp)) as TeamDaemonFrame;
    expect(round).toEqual(resp);
    expect(isResponse(round)).toBe(true);
  });

  it("notification frame round-trips", () => {
    const notif: TeamDaemonFrame = {
      kind: "notification",
      method: "team_event",
      params: { ts: 1746000000000, type: "worker_spawned" },
    };
    const round = JSON.parse(JSON.stringify(notif)) as TeamDaemonFrame;
    expect(round).toEqual(notif);
    expect(isNotification(round)).toBe(true);
  });
});
