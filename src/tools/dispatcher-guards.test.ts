/**
 * Dispatcher × harness-guard integration (docs/63 P0).
 *
 * The contract under test: guards are evaluated after schema validation and
 * before execute, a firing guard blocks the call with no side effects, and an
 * absent registry leaves dispatch behaviour exactly as it was.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolDispatcher } from "./dispatcher.js";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "./types.js";
import type { JsonSchema, ToolSpec } from "../core/types.js";
import { GuardRegistry, guardId, type HarnessGuard } from "../harness/guards.js";

const ctx: ToolExecutionContext = { cwd: "/tmp" };

const editSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string(),
});

function makeEditTool(calls: unknown[]): ToolImpl {
  const spec: ToolSpec = {
    name: "edit_file",
    description: "test edit tool",
    inputSchema: z.toJSONSchema(editSchema) as JsonSchema,
    requiredPermission: "write",
    tier: 0,
  };
  return {
    spec,
    zodSchema: editSchema,
    execute: async (input: unknown): Promise<ToolResult> => {
      calls.push(input);
      return { status: "ok", output: "edited" };
    },
  };
}

function shortOldStringGuard(): HarnessGuard {
  const predicate = { kind: "field_length_lt" as const, field: "old_string", length: 10 };
  return {
    id: guardId("edit_file", predicate),
    targetTool: "edit_file",
    predicate,
    message: "old_string must include surrounding context in this repo",
    failureSignature: "ambiguous-old-string",
    effect: "restrictive",
  };
}

describe("ToolDispatcher × guards", () => {
  it("executes normally when no registry is configured", async () => {
    const calls: unknown[] = [];
    const d = new ToolDispatcher();
    d.register(makeEditTool(calls));

    const res = await d.dispatch("edit_file", { file_path: "a.ts", old_string: "x" }, ctx);
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("blocks a matching call and does not execute the tool", async () => {
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    guards.register(shortOldStringGuard());
    const d = new ToolDispatcher({ guards });
    d.register(makeEditTool(calls));

    const res = await d.dispatch("edit_file", { file_path: "a.ts", old_string: "x" }, ctx);

    expect(res.status).toBe("error");
    expect(res.status === "error" && res.message).toContain("surrounding context");
    expect(res.status === "error" && res.message).toContain("harness guard");
    // The critical property: no side effect.
    expect(calls).toHaveLength(0);
  });

  it("lets a non-matching call through", async () => {
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    guards.register(shortOldStringGuard());
    const d = new ToolDispatcher({ guards });
    d.register(makeEditTool(calls));

    const res = await d.dispatch(
      "edit_file",
      { file_path: "a.ts", old_string: "a sufficiently long anchor" },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("does not apply a guard to a different tool", async () => {
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    guards.register({ ...shortOldStringGuard(), targetTool: "write_file" });
    const d = new ToolDispatcher({ guards });
    d.register(makeEditTool(calls));

    const res = await d.dispatch("edit_file", { file_path: "a.ts", old_string: "x" }, ctx);
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("runs schema validation BEFORE guards, so predicates see valid input", async () => {
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    guards.register(shortOldStringGuard());
    const d = new ToolDispatcher({ guards });
    d.register(makeEditTool(calls));

    // file_path missing → schema error, not a guard block.
    const res = await d.dispatch("edit_file", { old_string: "x" }, ctx);
    expect(res.status).toBe("error");
    expect(res.status === "error" && res.message).not.toContain("harness guard");
    expect(calls).toHaveLength(0);
    // The guard never ran, so it recorded no evaluation.
    const g = shortOldStringGuard();
    expect(guards.evidenceFor(g.id)?.evaluated).toBe(0);
  });

  it("records evidence for the LH1 compliance metric across a session", async () => {
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    guards.register(shortOldStringGuard());
    const d = new ToolDispatcher({ guards });
    d.register(makeEditTool(calls));

    await d.dispatch("edit_file", { file_path: "a.ts", old_string: "x" }, ctx); // blocked
    await d.dispatch("edit_file", { file_path: "a.ts", old_string: "y" }, ctx); // blocked
    await d.dispatch("edit_file", { file_path: "a.ts", old_string: "long enough anchor" }, ctx);

    const summary = guards.summary();
    expect(summary.totalEvaluated).toBe(3);
    expect(summary.totalFired).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("still reports unknown tools before consulting guards", async () => {
    const guards = new GuardRegistry();
    guards.register(shortOldStringGuard());
    const d = new ToolDispatcher({ guards });

    const res = await d.dispatch("edit_file", { file_path: "a.ts", old_string: "x" }, ctx);
    expect(res.status).toBe("error");
    expect(res.status === "error" && res.message).not.toContain("harness guard");
  });
});
