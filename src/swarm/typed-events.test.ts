import { describe, it, expect } from "vitest";
import {
  narrowLaneEvent,
  assertNeverEvent,
  type LaneEvent,
  type TypedLaneEvent,
  type FailureClass,
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

// v0.2.Q6 — turn primitive fixtures
const textDeltaPayload = { text: "hello world" };
const toolUseStartPayload = { toolUseId: "tu-1", toolName: "bash", toolInput: { command: "ls" } };
const toolUseInputPayload = { toolUseId: "tu-1", partialJson: '{"co' };
const toolUseEndPayload = { toolUseId: "tu-1" };
const toolResultPayload = { toolUseId: "tu-1", content: "file.txt\n", isError: false };
const messageStopPayload = { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };

// v0.2.Q6 — task lifecycle fixtures
const taskCreatedPayload = { taskId: "task-1", prompt: "do the thing" };
const taskUpdatedPayload = { taskId: "task-1", patch: { status: "running" } };
const taskCompletedPayload = { taskId: "task-1", output: "done", usage: { inputTokens: 10, outputTokens: 5 } };
const taskFailedPayload: { taskId: string; error: string; failureClass: FailureClass } = {
  taskId: "task-1",
  error: "something went wrong",
  failureClass: "timeout",
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

  it("returns undefined for an untyped event (e.g. heartbeat)", () => {
    const event = makeBase("heartbeat", {});
    expect(narrowLaneEvent(event)).toBeUndefined();
  });

  // v0.2.Q6 — turn primitives
  it("returns typed shape for text_delta", () => {
    const result = narrowLaneEvent(makeBase("text_delta", textDeltaPayload));
    expect(result?.type).toBe("text_delta");
    expect(result?.payload).toEqual(textDeltaPayload);
  });

  it("returns typed shape for tool_use_start", () => {
    const result = narrowLaneEvent(makeBase("tool_use_start", toolUseStartPayload));
    expect(result?.type).toBe("tool_use_start");
    expect(result?.payload).toEqual(toolUseStartPayload);
  });

  it("returns typed shape for tool_use_input", () => {
    const result = narrowLaneEvent(makeBase("tool_use_input", toolUseInputPayload));
    expect(result?.type).toBe("tool_use_input");
    expect(result?.payload).toEqual(toolUseInputPayload);
  });

  it("returns typed shape for tool_use_end", () => {
    const result = narrowLaneEvent(makeBase("tool_use_end", toolUseEndPayload));
    expect(result?.type).toBe("tool_use_end");
    expect(result?.payload).toEqual(toolUseEndPayload);
  });

  it("returns typed shape for tool_result", () => {
    const result = narrowLaneEvent(makeBase("tool_result", toolResultPayload));
    expect(result?.type).toBe("tool_result");
    expect(result?.payload).toEqual(toolResultPayload);
  });

  it("returns typed shape for message_stop", () => {
    const result = narrowLaneEvent(makeBase("message_stop", messageStopPayload));
    expect(result?.type).toBe("message_stop");
    expect(result?.payload).toEqual(messageStopPayload);
  });

  // v0.2.Q6 — task lifecycle
  it("returns typed shape for task_created", () => {
    const result = narrowLaneEvent(makeBase("task_created", taskCreatedPayload));
    expect(result?.type).toBe("task_created");
    expect(result?.payload).toEqual(taskCreatedPayload);
  });

  it("returns typed shape for task_updated", () => {
    const result = narrowLaneEvent(makeBase("task_updated", taskUpdatedPayload));
    expect(result?.type).toBe("task_updated");
    expect(result?.payload).toEqual(taskUpdatedPayload);
  });

  it("returns typed shape for task_completed", () => {
    const result = narrowLaneEvent(makeBase("task_completed", taskCompletedPayload));
    expect(result?.type).toBe("task_completed");
    expect(result?.payload).toEqual(taskCompletedPayload);
  });

  it("returns typed shape for task_failed", () => {
    const result = narrowLaneEvent(makeBase("task_failed", taskFailedPayload));
    expect(result?.type).toBe("task_failed");
    expect(result?.payload).toEqual(taskFailedPayload);
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
    // v0.2.Q6 — turn primitives
    case "text_delta":
      return `text_delta:${e.payload.text}`;
    case "tool_use_start":
      return `tool_use_start:${e.payload.toolName}`;
    case "tool_use_input":
      return `tool_use_input:${e.payload.toolUseId}`;
    case "tool_use_end":
      return `tool_use_end:${e.payload.toolUseId}`;
    case "tool_result":
      return `tool_result:${e.payload.toolUseId}`;
    case "message_stop":
      return `message_stop:${e.payload.stopReason ?? "none"}`;
    // v0.2.Q6 — task lifecycle
    case "task_created":
      return `task_created:${e.payload.taskId}`;
    case "task_updated":
      return `task_updated:${e.payload.taskId}`;
    case "task_completed":
      return `task_completed:${e.payload.taskId}`;
    case "task_failed":
      return `task_failed:${e.payload.taskId}`;
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

  // v0.2.Q6 — turn primitives
  it("handles text_delta", () => {
    const typed = narrowLaneEvent(makeBase("text_delta", textDeltaPayload))!;
    expect(describeTypedEvent(typed)).toBe("text_delta:hello world");
  });

  it("handles tool_use_start", () => {
    const typed = narrowLaneEvent(makeBase("tool_use_start", toolUseStartPayload))!;
    expect(describeTypedEvent(typed)).toBe("tool_use_start:bash");
  });

  it("handles tool_use_input", () => {
    const typed = narrowLaneEvent(makeBase("tool_use_input", toolUseInputPayload))!;
    expect(describeTypedEvent(typed)).toBe("tool_use_input:tu-1");
  });

  it("handles tool_use_end", () => {
    const typed = narrowLaneEvent(makeBase("tool_use_end", toolUseEndPayload))!;
    expect(describeTypedEvent(typed)).toBe("tool_use_end:tu-1");
  });

  it("handles tool_result", () => {
    const typed = narrowLaneEvent(makeBase("tool_result", toolResultPayload))!;
    expect(describeTypedEvent(typed)).toBe("tool_result:tu-1");
  });

  it("handles message_stop", () => {
    const typed = narrowLaneEvent(makeBase("message_stop", messageStopPayload))!;
    expect(describeTypedEvent(typed)).toBe("message_stop:end_turn");
  });

  // v0.2.Q6 — task lifecycle
  it("handles task_created", () => {
    const typed = narrowLaneEvent(makeBase("task_created", taskCreatedPayload))!;
    expect(describeTypedEvent(typed)).toBe("task_created:task-1");
  });

  it("handles task_updated", () => {
    const typed = narrowLaneEvent(makeBase("task_updated", taskUpdatedPayload))!;
    expect(describeTypedEvent(typed)).toBe("task_updated:task-1");
  });

  it("handles task_completed", () => {
    const typed = narrowLaneEvent(makeBase("task_completed", taskCompletedPayload))!;
    expect(describeTypedEvent(typed)).toBe("task_completed:task-1");
  });

  it("handles task_failed", () => {
    const typed = narrowLaneEvent(makeBase("task_failed", taskFailedPayload))!;
    expect(describeTypedEvent(typed)).toBe("task_failed:task-1");
  });
});
