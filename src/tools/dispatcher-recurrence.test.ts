/**
 * Dispatcher × failure-recurrence integration (docs/63 P0 trigger).
 *
 * The load-bearing assertions here are the *exclusions*: guard blocks and
 * schema errors must never be counted as recurring failures. Counting a guard
 * block would be a feedback loop (a guard would prompt guarding the guard);
 * nudging on a schema error would be useless, since a guard cannot pre-empt
 * validation.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolDispatcher } from "./dispatcher.js";
import { GuardRegistry, guardId, type HarnessGuard } from "../harness/guards.js";
import { FailureRecurrenceTracker } from "../harness/recurrence.js";
import type { JsonSchema, ToolSpec } from "../core/types.js";
import type { ToolExecutionContext, ToolImpl, ToolResult } from "./types.js";

const ctx: ToolExecutionContext = { cwd: "/tmp" };

const schema = z.object({ file_path: z.string().min(1) });

function failingTool(message: () => string): ToolImpl {
  const spec: ToolSpec = {
    name: "edit_file",
    description: "always fails",
    inputSchema: z.toJSONSchema(schema) as JsonSchema,
    requiredPermission: "write",
    tier: 0,
  };
  return {
    spec,
    zodSchema: schema,
    execute: async (): Promise<ToolResult> => ({ status: "error", message: message() }),
  };
}

function okTool(name: string): ToolImpl {
  const spec: ToolSpec = {
    name,
    description: "always succeeds",
    inputSchema: z.toJSONSchema(schema) as JsonSchema,
    requiredPermission: "write",
    tier: 0,
  };
  return { spec, zodSchema: schema, execute: async () => ({ status: "ok", output: "fine" }) };
}

describe("ToolDispatcher × recurrence", () => {
  it("appends a nudge on the second matching failure, not the first", async () => {
    const recurrence = new FailureRecurrenceTracker();
    const d = new ToolDispatcher({ recurrence });
    d.register(failingTool(() => "File does not exist: /tmp/a.ts"));

    const first = await d.dispatch("edit_file", { file_path: "a.ts" }, ctx);
    expect(first.status === "error" && first.message).not.toContain("define_guard");

    const second = await d.dispatch("edit_file", { file_path: "b.ts" }, ctx);
    expect(second.status === "error" && second.message).toContain("define_guard");
    // The original message survives — the nudge is appended, not substituted.
    expect(second.status === "error" && second.message).toContain("File does not exist");
  });

  it("does not nudge for distinct failures", async () => {
    const recurrence = new FailureRecurrenceTracker();
    let n = 0;
    const d = new ToolDispatcher({ recurrence });
    d.register(failingTool(() => (n++ === 0 ? "File does not exist" : "File has not been read yet")));

    await d.dispatch("edit_file", { file_path: "a.ts" }, ctx);
    const second = await d.dispatch("edit_file", { file_path: "b.ts" }, ctx);
    expect(second.status === "error" && second.message).not.toContain("define_guard");
  });

  it("never counts a guard block (no feedback loop)", async () => {
    const recurrence = new FailureRecurrenceTracker();
    const guards = new GuardRegistry();
    const predicate = { kind: "field_matches" as const, field: "file_path", pattern: ".*" };
    const guard: HarnessGuard = {
      id: guardId("edit_file", predicate),
      targetTool: "edit_file",
      predicate,
      message: "blocked",
      failureSignature: "test",
      effect: "restrictive",
    };
    guards.register(guard);

    const d = new ToolDispatcher({ guards, recurrence });
    d.register(failingTool(() => "unreachable"));

    for (let i = 0; i < 5; i++) {
      const res = await d.dispatch("edit_file", { file_path: `f${i}.ts` }, ctx);
      expect(res.status === "error" && res.message).not.toContain("define_guard");
    }
    expect(recurrence.summary().totalFailures).toBe(0);
  });

  it("never counts a schema-validation error", async () => {
    const recurrence = new FailureRecurrenceTracker();
    const d = new ToolDispatcher({ recurrence });
    d.register(okTool("edit_file"));

    for (let i = 0; i < 4; i++) {
      const res = await d.dispatch("edit_file", { file_path: "" }, ctx);
      expect(res.status).toBe("error");
      expect(res.status === "error" && res.message).not.toContain("define_guard");
    }
    expect(recurrence.summary().totalFailures).toBe(0);
  });

  it("does not count successes", async () => {
    const recurrence = new FailureRecurrenceTracker();
    const d = new ToolDispatcher({ recurrence });
    d.register(okTool("edit_file"));

    await d.dispatch("edit_file", { file_path: "a.ts" }, ctx);
    await d.dispatch("edit_file", { file_path: "b.ts" }, ctx);
    expect(recurrence.summary().totalFailures).toBe(0);
  });

  it("leaves results untouched when no tracker is configured", async () => {
    const d = new ToolDispatcher();
    d.register(failingTool(() => "File does not exist"));

    await d.dispatch("edit_file", { file_path: "a.ts" }, ctx);
    const second = await d.dispatch("edit_file", { file_path: "b.ts" }, ctx);
    expect(second.status === "error" && second.message).toBe("File does not exist");
  });

  it("records the control observation: repeats with no guard installed", async () => {
    const recurrence = new FailureRecurrenceTracker();
    const guards = new GuardRegistry();
    const d = new ToolDispatcher({ guards, recurrence });
    d.register(failingTool(() => "File does not exist: /tmp/x.ts"));

    await d.dispatch("edit_file", { file_path: "a.ts" }, ctx);
    await d.dispatch("edit_file", { file_path: "b.ts" }, ctx);
    await d.dispatch("edit_file", { file_path: "c.ts" }, ctx);

    expect(recurrence.summary().repeatedFailures).toBe(1);
    expect(recurrence.summary().prompted).toBe(1);
    expect(guards.summary().guardCount).toBe(0);
  });

  it("control arm (recurrenceNudge:false) counts failures but appends no nudge", async () => {
    const recurrence = new FailureRecurrenceTracker();
    const d = new ToolDispatcher({ recurrence, recurrenceNudge: false });
    d.register(failingTool(() => "File does not exist: /tmp/a.ts"));

    const first = await d.dispatch("edit_file", { file_path: "a.ts" }, ctx);
    const second = await d.dispatch("edit_file", { file_path: "b.ts" }, ctx);
    // No nudge on either call...
    expect(first.status === "error" && first.message).not.toContain("define_guard");
    expect(second.status === "error" && second.message).not.toContain("define_guard");
    // ...but the failure IS still counted, so the LH1 metric is identical to the
    // treatment arm.
    const s = recurrence.summary();
    expect(s.totalFailures).toBe(2);
    expect(s.repeatedFailures).toBe(1);
    expect(s.prompted).toBe(1); // the tracker still marks it prompt-worthy; the dispatcher just didn't emit
  });
});
