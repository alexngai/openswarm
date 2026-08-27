import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { composeSystemPrompt, editInputForToolEnd } from "./worker-entry.js";
import { WorkerHost } from "../swarm/worker-host.js";
import type { ParentTransport } from "../swarm/ipc/parent-transport.js";
import type { AgentId, PermissionMode } from "../core/types.js";

// M1 regression: the previous implementation did
//   `roleSuffix.length > 0 ? roleSuffix : ""`
// which REPLACED the parent's base prompt. Plan §6.6 mandates append
// semantics: base first, role suffix appended so it wins on conflicts.

describe("composeSystemPrompt (M1 regression)", () => {
  it("returns empty string when both inputs are empty", () => {
    expect(composeSystemPrompt("", "")).toBe("");
    expect(composeSystemPrompt(undefined, undefined)).toBe("");
  });

  it("returns the role suffix alone when base is empty", () => {
    expect(composeSystemPrompt("", "You are an architect.")).toBe(
      "You are an architect.",
    );
  });

  it("returns the base alone when role suffix is empty", () => {
    expect(composeSystemPrompt("You are a coder.", "")).toBe(
      "You are a coder.",
    );
  });

  it("places base first, role suffix second, separated by a blank line", () => {
    const base = "Base directives: be concise.";
    const suffix = "Role overlay: only edit tests.";
    const combined = composeSystemPrompt(base, suffix);
    // Both present.
    expect(combined).toContain(base);
    expect(combined).toContain(suffix);
    // Base appears before suffix (role wins on conflicts → lands last).
    expect(combined.indexOf(base)).toBeLessThan(combined.indexOf(suffix));
    // Joined with a blank-line separator.
    expect(combined).toBe(`${base}\n\n${suffix}`);
  });

  it("inserts tool warmup before the role suffix", () => {
    const combined = composeSystemPrompt(
      "Base directives.",
      "Role overlay.",
      "Tool warmup.",
    );

    expect(combined).toBe("Base directives.\n\nTool warmup.\n\nRole overlay.");
  });
});

// ---------------------------------------------------------------------------
// Issue #26 — the recorded tool_use_end `input` attached at the team forward
// loop for edit tools (bounded + secret-redacted); non-edit tools carry none.
// ---------------------------------------------------------------------------

describe("editInputForToolEnd (issue #26 forward-loop contract)", () => {
  it("attaches parsed input for an edit tool", () => {
    const input = editInputForToolEnd(
      "edit_file",
      JSON.stringify({
        file_path: "a.ts",
        old_string: "const x = 1",
        new_string: "const x = 2",
      }),
    ) as Record<string, unknown>;
    expect(input).toEqual({
      file_path: "a.ts",
      old_string: "const x = 1",
      new_string: "const x = 2",
    });
  });

  it("returns undefined for a non-edit tool (no input forwarded)", () => {
    expect(
      editInputForToolEnd("read_file", JSON.stringify({ file_path: "a.ts" })),
    ).toBeUndefined();
    expect(
      editInputForToolEnd("bash", JSON.stringify({ command: "ls" })),
    ).toBeUndefined();
    expect(editInputForToolEnd(undefined, "")).toBeUndefined();
  });

  it("redacts a planted secret in new_string", () => {
    // A realistic OpenAI-style key embedded in the replacement text.
    const fakeKey =
      "sk-" + "A".repeat(20) + "T3BlbkFJ" + "B".repeat(20);
    const input = editInputForToolEnd(
      "edit_file",
      JSON.stringify({
        file_path: ".env",
        old_string: "OPENAI_API_KEY=",
        new_string: `OPENAI_API_KEY=${fakeKey}`,
      }),
    ) as Record<string, string>;
    expect(input.new_string).not.toContain(fakeKey);
    expect(input.new_string).toContain("[REDACTED:openai-key]");
  });

  it("also redacts a planted AWS access key", () => {
    const awsKey = "AKIA" + "ABCDEFGHIJKLMNOP";
    const input = editInputForToolEnd(
      "write_file",
      JSON.stringify({ file_path: "creds.txt", content: `key=${awsKey}` }),
    ) as Record<string, string>;
    expect(input.content).not.toContain(awsKey);
    expect(input.content).toContain("[REDACTED:aws-access-key]");
  });

  it("size-caps new_string to a sane char limit", () => {
    const huge = "y".repeat(50_000);
    const input = editInputForToolEnd(
      "edit_file",
      JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: huge }),
    ) as Record<string, string>;
    // Capped well below the original 50k (16k cap + a 1-char ellipsis).
    expect(input.new_string.length).toBeLessThanOrEqual(16_001);
    expect(input.new_string.endsWith("…")).toBe(true);
  });

  it("leaves apply_patch `patch` verbatim so it stays parseable", () => {
    const patch =
      "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
    const input = editInputForToolEnd(
      "apply_patch",
      JSON.stringify({ patch }),
    ) as Record<string, string>;
    expect(input.patch).toBe(patch);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle sequence — exercises the hook points wired in runWorkerEntry via
// the public WorkerHost wrappers. Full IPC integration is omitted (runWorkerEntry
// requires real subprocess transport); this exercises the wrapper sequence
// that worker-entry calls: markReadyForPrompt → markRunning → markFinished.
// ---------------------------------------------------------------------------

function makeFakeTransport(): ParentTransport {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    send: vi.fn(),
    notify: vi.fn(async () => {}),
    respond: vi.fn(),
    respondError: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    close: vi.fn(),
  }) as unknown as ParentTransport;
}

describe("worker-entry lifecycle sequence (via WorkerHost wrappers)", () => {
  it("happy path fires lane events in order: spawning→ready_for_prompt→prompt_accepted→running→finished", () => {
    const transport = makeFakeTransport();
    const host = new WorkerHost(
      "agent-test" as AgentId,
      1,
      "workspace-write" as PermissionMode,
      transport,
    );

    const notifyFn = transport.notify as ReturnType<typeof vi.fn>;

    // Initial state — no events yet.
    expect(host.getLifecycleState()).toBe("spawning");
    expect(notifyFn).not.toHaveBeenCalled();

    // worker_ready handshake completes → ready_for_prompt.
    host.markReadyForPrompt();
    expect(host.getLifecycleState()).toBe("ready_for_prompt");

    // "run" request arrives → prompt_accepted + running.
    host.markRunning();
    expect(host.getLifecycleState()).toBe("running");

    // task_result emitted → finished.
    host.markFinished();
    expect(host.getLifecycleState()).toBe("finished");

    // Extract only worker_lifecycle_changed payloads from lane_event calls.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycleEvents = (notifyFn.mock.calls as any[])
      .filter((c: any[]) => c[0] === "lane_event")
      .map((c: any[]) => c[1] as { type: string; payload: { from: string; to: string } })
      .filter((p) => p.type === "worker_lifecycle_changed")
      .map((p) => `${p.payload.from}→${p.payload.to}`);

    expect(lifecycleEvents).toEqual([
      "spawning→ready_for_prompt",
      "ready_for_prompt→prompt_accepted",
      "prompt_accepted→running",
      "running→finished",
    ]);
  });

  it("failure path fires failed event with failureClass and reason", () => {
    const transport = makeFakeTransport();
    const host = new WorkerHost(
      "agent-fail" as AgentId,
      1,
      "workspace-write" as PermissionMode,
      transport,
    );

    host.markReadyForPrompt();
    host.markRunning();
    host.markFailed("panic", "engine threw");

    expect(host.getLifecycleState()).toBe("failed");

    const notifyFn = transport.notify as ReturnType<typeof vi.fn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastLifecycle = (notifyFn.mock.calls as any[])
      .filter((c: any[]) => c[0] === "lane_event")
      .map((c: any[]) => c[1] as { type: string; payload: Record<string, unknown> })
      .filter((p) => p.type === "worker_lifecycle_changed")
      .at(-1)!;

    expect(lastLifecycle.payload.to).toBe("failed");
    expect(lastLifecycle.payload.failureClass).toBe("panic");
    expect(lastLifecycle.payload.reason).toBe("engine threw");
  });
});
