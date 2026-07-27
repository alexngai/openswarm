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

    // Before: a normal source-file write succeeds. (It must NOT match the guard
    // installed below, or the validation gate (§10.4) would reject that guard for
    // blocking a call already seen to succeed — which is the gate working correctly.)
    const before = await dispatcher.dispatch(
      "write_file",
      { file_path: "src/app.ts", content: "x" },
      ctx,
    );
    expect(before.status).toBe("ok");
    expect(calls).toHaveLength(1);

    // The agent installs a guard against writing to generated files (a pattern that has
    // NOT succeeded this session, so the gate admits it).
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

    // After: a matching write is blocked, and the tool never runs.
    const after = await dispatcher.dispatch(
      "write_file",
      { file_path: "a.generated.ts", content: "x" },
      ctx,
    );
    expect(after.status).toBe("error");
    expect(after.status === "error" && after.message).toContain("edit the source template");
    expect(calls).toHaveLength(1); // unchanged — no side effect

    // A non-matching write still works: the guard narrowed, it did not close the tool.
    const ok = await dispatcher.dispatch("write_file", { file_path: "b.ts", content: "x" }, ctx);
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

  it("validation gate: a successful dispatch records a success that rejects a later over-broad guard", async () => {
    // Reproduces the Nova Pro pathology end-to-end through the dispatcher.
    const calls: unknown[] = [];
    const guards = new GuardRegistry();
    setGuardRegistry(guards);
    const dispatcher = new ToolDispatcher({ guards });
    dispatcher.register(makeWriteTool(calls));
    dispatcher.register(defineGuardTool);

    // A normal successful write (no replace_all field) — the dispatcher records it.
    const ok = await dispatcher.dispatch(
      "write_file",
      { file_path: "a.ts", content: "hello" },
      ctx,
    );
    expect(ok.status).toBe("ok");

    // Now try to install an over-broad guard (blocks any write with non-empty content).
    const install = await dispatcher.dispatch(
      "define_guard",
      {
        action: "define",
        target_tool: "write_file",
        predicate: { kind: "field_matches", field: "content", pattern: "." },
        message: "too restrictive",
        failure_signature: "over-broad",
      },
      ctx,
    );
    // The gate rejects it because it would have blocked the recorded successful write.
    expect(install.status).toBe("error");
    expect(install.status === "error" && install.message).toContain("too broad");
    expect(guards.list()).toHaveLength(0);

    // And the tool still works — the over-broad guard never took effect.
    const after = await dispatcher.dispatch("write_file", { file_path: "b.ts", content: "y" }, ctx);
    expect(after.status).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});
