/**
 * Dispatcher error-trapping — v0.4 stage 4I (Defect 2).
 *
 * Tools that throw (instead of returning `{status: "error"}`) must surface as
 * structured error results, not unhandled promise rejections. This test
 * documents the invariant.
 */

import { describe, it, expect } from "vitest";
import { ToolDispatcher } from "./dispatcher.js";
import type { ToolImpl, ToolExecutionContext } from "./types.js";

const ctx: ToolExecutionContext = { cwd: "/tmp" };

function makeThrowingTool(name: string, error: unknown): ToolImpl {
  return {
    spec: {
      name,
      description: `${name} tool that throws`,
      inputSchema: { type: "object", properties: {}, required: [] },
      requiredPermission: "none",
      tier: 0,
    },
    execute: async () => {
      throw error;
    },
  };
}

describe("ToolDispatcher — execute() throws (v0.4 stage 4I Defect 2)", () => {
  it("converts a thrown Error into a structured error ToolResult", async () => {
    const dispatcher = new ToolDispatcher();
    dispatcher.register(makeThrowingTool("boom-tool", new Error("boom")));

    const result = await dispatcher.dispatch("boom-tool", {}, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("boom");
    }
  });

  it("converts a thrown non-Error value into a structured error with stringified message", async () => {
    const dispatcher = new ToolDispatcher();
    dispatcher.register(makeThrowingTool("string-throw", "raw string failure"));

    const result = await dispatcher.dispatch("string-throw", {}, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("raw string failure");
    }
  });

  it("does not propagate the thrown error as an unhandled rejection", async () => {
    // If dispatch failed to catch, awaiting it would reject. The await here
    // succeeding (with a structured error) IS the assertion.
    const dispatcher = new ToolDispatcher();
    dispatcher.register(
      makeThrowingTool("rejector", new Error("nope")),
    );

    await expect(
      dispatcher.dispatch("rejector", {}, ctx),
    ).resolves.toMatchObject({ status: "error", message: "nope" });
  });

  it("tools that return {status: 'error'} are unaffected (semantics preserved)", async () => {
    const dispatcher = new ToolDispatcher();
    dispatcher.register({
      spec: {
        name: "structured-error",
        description: "returns structured error",
        inputSchema: { type: "object", properties: {}, required: [] },
        requiredPermission: "none",
        tier: 0,
      },
      execute: async () => ({
        status: "error",
        message: "structured failure",
      }),
    });

    const result = await dispatcher.dispatch("structured-error", {}, ctx);
    expect(result).toEqual({
      status: "error",
      message: "structured failure",
    });
  });
});
