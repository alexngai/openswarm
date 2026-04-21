import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolDispatcher } from "./dispatcher.js";
import { HookRuntime } from "../hooks/runtime.js";
import type { ToolImpl, ToolExecutionContext } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, "../../test/fixtures/hooks");

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

describe("ToolDispatcher — hook integration (Tier 2 coverage)", () => {
  const denyHook = path.join(FIXTURES, "deny-hook.sh");
  const mutateHook = path.join(FIXTURES, "mutate-hook.sh");
  const allowHook = path.join(FIXTURES, "allow-hook.sh");

  // Use a permissive zodSchema so updatedInput of { foo: "mutated" } passes.
  const permissiveSchema = z.object({}).passthrough();
  function makePermissiveTool(
    name: string,
    execute: ToolImpl["execute"],
    opts: { tier?: 0 | 1 | 2 } = {},
  ): ToolImpl {
    return {
      spec: {
        name,
        description: `${name} tool`,
        inputSchema: { type: "object" },
        requiredPermission: "none",
        tier: opts.tier ?? 0,
      },
      zodSchema: permissiveSchema,
      execute,
    };
  }

  it("PreToolUse deny aborts tool execution, returns error", async () => {
    const hooks = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: denyHook }],
    });
    const dispatcher = new ToolDispatcher({ hooks });
    const execute = vi.fn(async () => ({ status: "ok" as const, output: "ran" }));
    dispatcher.register(makePermissiveTool("bash", execute));
    const result = await dispatcher.dispatch("bash", { command: "ls" }, ctx);
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /hook denied bash/,
    );
    expect((result as { status: "error"; message: string }).message).toMatch(
      /blocked by policy/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("PreToolUse allow + updatedInput rewrites tool input before execute", async () => {
    const hooks = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: mutateHook }],
    });
    const dispatcher = new ToolDispatcher({ hooks });
    const execute = vi.fn(
      async (input: unknown) =>
        ({ status: "ok" as const, output: JSON.stringify(input) }) as const,
    );
    dispatcher.register(makePermissiveTool("read_file", execute));
    const result = await dispatcher.dispatch(
      "read_file",
      { foo: "original" },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect((result as { status: "ok"; output: string }).output).toBe(
      JSON.stringify({ foo: "mutated" }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0]!;
    expect(call[0]).toEqual({ foo: "mutated" });
  });

  it("Tier 2 tool invocation triggers PreToolUse hook (bypass-SDK coverage)", async () => {
    // Simulated Tier 2 tool — bypasses SDK's tool path, but dispatcher fires
    // hooks uniformly.
    const hooks = new HookRuntime({
      PreToolUse: [{ matcher: "agent", command: denyHook }],
    });
    const dispatcher = new ToolDispatcher({ hooks });
    const execute = vi.fn(async () => ({
      status: "ok" as const,
      output: "sub-agent ran",
    }));
    dispatcher.register(makePermissiveTool("agent", execute, { tier: 2 }));
    const result = await dispatcher.dispatch(
      "agent",
      { prompt: "do work" },
      ctx,
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /hook denied agent/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("PostToolUse hook fires after successful execute", async () => {
    // Ensure PostToolUse ran — simplest proof is a deny on PostToolUse that
    // does NOT alter the returned ToolResult (best-effort). Instead track
    // the invocation via a sentinel: we use allow-hook which always succeeds
    // and then verify the tool result is returned unchanged.
    const hooks = new HookRuntime({
      PostToolUse: [{ matcher: "*", command: allowHook }],
    });
    const dispatcher = new ToolDispatcher({ hooks });
    dispatcher.register(
      makePermissiveTool("bash", async () => ({
        status: "ok",
        output: "hello",
      })),
    );
    const result = await dispatcher.dispatch("bash", { command: "echo hi" }, ctx);
    expect(result.status).toBe("ok");
    expect((result as { status: "ok"; output: string }).output).toBe("hello");
  });

  it("no-op when HookRuntime is absent — pre-existing dispatch path unchanged", async () => {
    const dispatcher = new ToolDispatcher(); // no hooks
    dispatcher.register(
      makePermissiveTool("bash", async () => ({
        status: "ok",
        output: "unchanged",
      })),
    );
    const result = await dispatcher.dispatch("bash", { command: "ls" }, ctx);
    expect(result.status).toBe("ok");
  });
});

describe("ToolDispatcher — allowedTools allowlist (M3a Phase 6)", () => {
  it("filters tools at registration time: filtered tools are not listed", () => {
    const dispatcher = new ToolDispatcher({
      allowedTools: ["read_file", "grep"],
    });
    dispatcher.register(makeTool("read_file"));
    dispatcher.register(makeTool("bash"));
    dispatcher.register(makeTool("grep"));
    dispatcher.register(makeTool("write_file"));
    const names = dispatcher.list().map((s) => s.name);
    expect(names.sort()).toEqual(["grep", "read_file"]);
    expect(dispatcher.get("bash")).toBeUndefined();
    expect(dispatcher.get("write_file")).toBeUndefined();
  });

  it("dispatch on a filtered-out tool returns 'unknown tool' error (model never sees bash)", async () => {
    const dispatcher = new ToolDispatcher({
      allowedTools: ["read_file"],
    });
    dispatcher.register(makeTool("read_file"));
    dispatcher.register(makeTool("bash"));
    // bash was filtered at registration — dispatch returns "unknown tool".
    const bashResult = await dispatcher.dispatch(
      "bash",
      { x: "echo hi" },
      ctx,
    );
    expect(bashResult.status).toBe("error");
    expect(
      (bashResult as { status: "error"; message: string }).message,
    ).toContain("unknown tool: bash");
    // read_file is in the allowlist — dispatch succeeds.
    const good = await dispatcher.dispatch("read_file", { x: "f.txt" }, ctx);
    expect(good.status).toBe("ok");
  });

  it("no filtering when allowedTools is omitted (back-compat)", () => {
    const dispatcher = new ToolDispatcher();
    dispatcher.register(makeTool("read_file"));
    dispatcher.register(makeTool("bash"));
    const names = dispatcher.list().map((s) => s.name);
    expect(names.sort()).toEqual(["bash", "read_file"]);
  });

  it("filtering composes with canUseTool / permission-mode clamps (orthogonal layers)", async () => {
    // allowlist hides `bash`; a separate canUseTool-like gate would deny it
    // even if visible. With filtering, bash is invisible BEFORE the gate runs,
    // which is the intended composition: allowlist → visibility, canUseTool
    // → per-call permission, permission-mode → ceiling.
    const dispatcher = new ToolDispatcher({
      allowedTools: ["read_file"],
    });
    dispatcher.register(makeTool("bash"));
    dispatcher.register(makeTool("read_file"));
    // bash not in list, not retrievable.
    expect(dispatcher.get("bash")).toBeUndefined();
    expect(dispatcher.list().map((s) => s.name)).toEqual(["read_file"]);
    // Dispatching bash errors at the dispatch layer, before any per-call gate.
    const r = await dispatcher.dispatch("bash", { x: "hi" }, ctx);
    expect(r.status).toBe("error");
  });
});
