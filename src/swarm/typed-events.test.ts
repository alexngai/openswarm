import { describe, it, expect } from "vitest";
import {
  narrowLaneEvent,
  assertNeverEvent,
  type LaneEvent,
  type TypedLaneEvent,
} from "./events.js";
import type { CommandIntent } from "../tools/tier0/bash-validation/intent.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBase(type: string, payload: unknown): LaneEvent {
  return { ts: 1000, agentId: "agent-1" as LaneEvent["agentId"], type: type as LaneEvent["type"], payload };
}

const blockedPayload = {
  command: "rm -rf /",
  submodule: "destructive",
  reason: "Always-destructive command",
  intent: "Destructive" as CommandIntent,
};

const warnedPayload = {
  command: "curl https://example.com",
  submodule: "mode",
  message: "Network access in read-only mode",
  decision: "denied" as const,
  intent: "Network" as CommandIntent,
};

const lifecyclePayload = {
  from: "spawning" as const,
  to: "ready_for_prompt" as const,
};

// ---------------------------------------------------------------------------
// narrowLaneEvent
// ---------------------------------------------------------------------------

describe("narrowLaneEvent", () => {
  it("returns typed shape for bash_validation_blocked", () => {
    const event = makeBase("bash_validation_blocked", blockedPayload);
    const result = narrowLaneEvent(event);
    expect(result).not.toBeUndefined();
    expect(result!.type).toBe("bash_validation_blocked");
    expect(result!.payload).toEqual(blockedPayload);
  });

  it("returns typed shape for bash_validation_warned", () => {
    const event = makeBase("bash_validation_warned", warnedPayload);
    const result = narrowLaneEvent(event);
    expect(result).not.toBeUndefined();
    expect(result!.type).toBe("bash_validation_warned");
    expect(result!.payload).toEqual(warnedPayload);
  });

  it("returns typed shape for worker_lifecycle_changed", () => {
    const event = makeBase("worker_lifecycle_changed", lifecyclePayload);
    const result = narrowLaneEvent(event);
    expect(result).not.toBeUndefined();
    expect(result!.type).toBe("worker_lifecycle_changed");
    expect(result!.payload).toEqual(lifecyclePayload);
  });

  it("returns undefined for an untyped event (e.g. text_delta)", () => {
    const event = makeBase("text_delta", { text: "hello" });
    expect(narrowLaneEvent(event)).toBeUndefined();
  });

  it("preserves the payload object reference", () => {
    const payload = { ...blockedPayload };
    const event = makeBase("bash_validation_blocked", payload);
    const result = narrowLaneEvent(event);
    // narrowLaneEvent casts — same object reference must come through
    expect(result!.payload).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// Exhaustiveness smoke test
// ---------------------------------------------------------------------------

/**
 * This function switches on every TypedLaneEvent variant and returns a
 * string per branch. The final `default: assertNeverEvent(e)` is the
 * exhaustiveness gate: adding a new TypedLaneEvent variant without adding
 * a case here becomes a compile error (tsc will report that the new variant
 * doesn't satisfy `never`).
 */
function describeTypedEvent(e: TypedLaneEvent): string {
  switch (e.type) {
    case "bash_validation_blocked":
      return `blocked:${e.payload.command}`;
    case "bash_validation_warned":
      return `warned:${e.payload.command}`;
    case "worker_lifecycle_changed":
      return `lifecycle:${e.payload.from}->${e.payload.to}`;
    default:
      return assertNeverEvent(e);
  }
}

describe("exhaustiveness: switch on TypedLaneEvent covers all variants", () => {
  it("handles bash_validation_blocked", () => {
    const event = makeBase("bash_validation_blocked", blockedPayload);
    const typed = narrowLaneEvent(event)!;
    expect(describeTypedEvent(typed)).toBe("blocked:rm -rf /");
  });

  it("handles bash_validation_warned", () => {
    const event = makeBase("bash_validation_warned", warnedPayload);
    const typed = narrowLaneEvent(event)!;
    expect(describeTypedEvent(typed)).toBe("warned:curl https://example.com");
  });

  it("handles worker_lifecycle_changed", () => {
    const event = makeBase("worker_lifecycle_changed", lifecyclePayload);
    const typed = narrowLaneEvent(event)!;
    expect(describeTypedEvent(typed)).toBe("lifecycle:spawning->ready_for_prompt");
  });
});
