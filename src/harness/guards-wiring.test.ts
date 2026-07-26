/**
 * Wiring test for docs/63 P0 — the guard registry reaching real dispatch.
 *
 * The unit tests cover the registry and the tool in isolation. This asserts
 * the property that actually matters in production: a guard installed through
 * the `define_guard` tool's seam is enforced by the same `ToolDispatcher` the
 * runtime hands to the engine, and blocks a real tool before it executes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { GuardRegistry } from "./guards.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import {
  clearGuardRegistry,
  defineGuardTool,
  setGuardRegistry,
} from "../tools/tier0/define_guard.js";
import type { JsonSchema, ToolSpec } from "../core/types.js";
import type { ToolExecutionContext, ToolImpl, ToolResult } from "../tools/types.js";

const ctx: ToolExecutionContext = { cwd: "/tmp" };

const writeSchema = z.object({ file_path: z.string().min(1), content: z.string() });

function makeWriteTool(calls: unknown[]): ToolImpl {
  const spec: ToolSpec = {
    name: "write_file",
    description: "test write tool",
    inputSchema: z.toJSONSchema(writeSchema) as JsonSchema,
    requiredPermission: "write",
    tier: 0,
  };
  return {
    spec,
    zodSchema: writeSchema,
    execute: async (input: unknown): Promise<ToolResult> => {
      calls.push(input);
      return { status: "ok", output: "written" };
    },
  };
}

afterEach(() => {
  clearGuardRegistry();
});

describe("guard wiring: define_guard → dispatcher", () => {
  it("a guard installed via the tool blocks a later call through the dispatcher", async () => {
    // Arrange the runtime shape: one registry, shared by the tool seam and
    // the dispatcher — exactly what buildAgentRuntime()/main.ts construct.
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    setGuardRegistry(guards);
    const dispatcher = new ToolDispatcher({ guards });
    dispatcher.register(makeWriteTool(calls));
    dispatcher.register(defineGuardTool);

    // Before: the write succeeds.
    const before = await dispatcher.dispatch(
      "write_file",
      { file_path: "a.generated.ts", content: "x" },
      ctx,
    );
    expect(before.status).toBe("ok");
    expect(calls).toHaveLength(1);

    // The agent notices it keeps editing generated files and installs a guard.
    const install = await dispatcher.dispatch(
      "define_guard",
      {
        action: "define",
        target_tool: "write_file",
        predicate: { kind: "field_matches", field: "file_path", pattern: "\\.generated\\." },
        message: "generated files are rebuilt; edit the source template instead",
        failure_signature: "edit-generated-file",
      },
      ctx,
    );
    expect(install.status).toBe("ok");

    // After: the same call is blocked, and the tool never runs.
    const after = await dispatcher.dispatch(
      "write_file",
      { file_path: "a.generated.ts", content: "x" },
      ctx,
    );
    expect(after.status).toBe("error");
    expect(after.status === "error" && after.message).toContain("edit the source template");
    expect(calls).toHaveLength(1); // unchanged — no side effect

    // A non-matching write still works: the guard narrowed, it did not close the tool.
    const ok = await dispatcher.dispatch("write_file", { file_path: "a.ts", content: "x" }, ctx);
    expect(ok.status).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("the session-end summary reports the compliance-failure count", async () => {
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    setGuardRegistry(guards);
    const dispatcher = new ToolDispatcher({ guards });
    dispatcher.register(makeWriteTool(calls));
    dispatcher.register(defineGuardTool);

    await dispatcher.dispatch(
      "define_guard",
      {
        action: "define",
        target_tool: "write_file",
        predicate: { kind: "field_matches", field: "file_path", pattern: "\\.generated\\." },
        message: "edit the template",
        failure_signature: "edit-generated-file",
      },
      ctx,
    );
    await dispatcher.dispatch("write_file", { file_path: "a.generated.ts", content: "x" }, ctx);
    await dispatcher.dispatch("write_file", { file_path: "b.generated.ts", content: "y" }, ctx);
    await dispatcher.dispatch("write_file", { file_path: "c.ts", content: "z" }, ctx);

    // This is the payload emitted as `harness_guard_summary` at session end.
    const summary = guards.summary();
    expect(summary.guardCount).toBe(1);
    expect(summary.totalFired).toBe(2);
    expect(summary.perGuard[0]?.failureSignature).toBe("edit-generated-file");
    expect(calls).toHaveLength(1);
  });

  it("an unwired registry leaves dispatch behaviour untouched", async () => {
    const calls: unknown[] = [];
    const dispatcher = new ToolDispatcher(); // no guards option
    dispatcher.register(makeWriteTool(calls));
    dispatcher.register(defineGuardTool);

    const res = await dispatcher.dispatch(
      "write_file",
      { file_path: "a.generated.ts", content: "x" },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});
