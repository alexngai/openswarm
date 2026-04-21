import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolDispatcher } from "./dispatcher.js";
import type { ToolImpl, ToolExecutionContext } from "./types.js";

const inputSchema = z.object({ x: z.string() });

const ctx: ToolExecutionContext = { cwd: "/tmp" };

function makeTool(
  name: string,
  execute: ToolImpl["execute"] = async (_input, _ctx) => ({
    status: "ok",
    output: "success",
  }),
): ToolImpl {
  return {
    spec: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      requiredPermission: "none",
      tier: 0,
    },
    zodSchema: inputSchema,
    execute,
  };
}

describe("ToolDispatcher", () => {
  it("registers a tool and retrieves it via get()", () => {
    const dispatcher = new ToolDispatcher();
    const tool = makeTool("my-tool");
    dispatcher.register(tool);
    expect(dispatcher.get("my-tool")).toBe(tool);
  });

  it("lists registered tool specs", () => {
    const dispatcher = new ToolDispatcher();
    dispatcher.register(makeTool("tool-a"));
    dispatcher.register(makeTool("tool-b"));
    const specs = dispatcher.list();
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.name)).toContain("tool-a");
    expect(specs.map((s) => s.name)).toContain("tool-b");
  });

  it("returns undefined for unregistered tool via get()", () => {
    const dispatcher = new ToolDispatcher();
    expect(dispatcher.get("nonexistent")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const dispatcher = new ToolDispatcher();
    dispatcher.register(makeTool("dup-tool"));
    expect(() => dispatcher.register(makeTool("dup-tool"))).toThrow(
      /duplicate tool registration.*dup-tool/,
    );
  });

  it("dispatch returns error for unknown tool", async () => {
    const dispatcher = new ToolDispatcher();
    const result = await dispatcher.dispatch("unknown", { x: "hello" }, ctx);
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toContain("unknown tool: unknown");
  });

  it("dispatch validates input via zodSchema and returns error on bad input", async () => {
    const dispatcher = new ToolDispatcher();
    dispatcher.register(makeTool("validated-tool"));
    // Pass a number instead of string for x
    const result = await dispatcher.dispatch("validated-tool", { x: 42 }, ctx);
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toBeTruthy();
  });

  it("dispatch passes ctx to execute", async () => {
    const dispatcher = new ToolDispatcher();
    const execute = vi.fn(async (_input: unknown, _ctx: ToolExecutionContext) => ({
      status: "ok" as const,
      output: "done",
    }));
    dispatcher.register(makeTool("ctx-tool", execute));
    await dispatcher.dispatch("ctx-tool", { x: "hello" }, ctx);
    expect(execute).toHaveBeenCalledWith({ x: "hello" }, ctx);
  });

  it("dispatch returns tool result unchanged on success", async () => {
    const dispatcher = new ToolDispatcher();
    const expected = { status: "ok" as const, output: "the result" };
    dispatcher.register(makeTool("result-tool", async () => expected));
    const result = await dispatcher.dispatch("result-tool", { x: "hello" }, ctx);
    expect(result).toEqual(expected);
  });

  it("dispatch skips validation when zodSchema is absent", async () => {
    const dispatcher = new ToolDispatcher();
    const tool: ToolImpl = {
      spec: {
        name: "no-schema-tool",
        description: "tool without zod schema",
        inputSchema: { type: "object" },
        requiredPermission: "none",
        tier: 0,
      },
      execute: async () => ({ status: "ok", output: "ran" }),
      // no zodSchema
    };
    dispatcher.register(tool);
    const result = await dispatcher.dispatch("no-schema-tool", { anything: true }, ctx);
    expect(result.status).toBe("ok");
  });
});
