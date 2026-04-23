import { describe, it, expect } from "vitest";
import { createInitialState, reduce } from "../../ui/repl/state.js";
import { buildDefaultRegistry } from "./index.js";
import { dispatchSlashLine, parseSlashLine } from "./dispatcher.js";

describe("parseSlashLine", () => {
  it("parses `/help` as {name:'help', args:[]}", () => {
    expect(parseSlashLine("/help")).toEqual({ name: "help", args: [] });
  });

  it("parses `/model sonnet`", () => {
    expect(parseSlashLine("/model sonnet")).toEqual({
      name: "model",
      args: ["sonnet"],
    });
  });

  it("splits multiple whitespace-delimited args", () => {
    expect(parseSlashLine("/resume   abc   def")).toEqual({
      name: "resume",
      args: ["abc", "def"],
    });
  });

  it("returns undefined for a non-slash line", () => {
    expect(parseSlashLine("help")).toBeUndefined();
  });

  it("returns undefined for a bare `/`", () => {
    expect(parseSlashLine("/")).toBeUndefined();
  });

  it("returns undefined for `/   ` (slash + whitespace only)", () => {
    expect(parseSlashLine("/   ")).toBeUndefined();
  });
});

describe("dispatchSlashLine", () => {
  it("returns an error for malformed input (no leading slash)", async () => {
    const registry = buildDefaultRegistry();
    const state = createInitialState();
    const res = await dispatchSlashLine("help", state, registry);
    expect(res.kind).toBe("error");
  });

  it("returns an error for unknown commands", async () => {
    const registry = buildDefaultRegistry();
    const state = createInitialState();
    const res = await dispatchSlashLine("/unknown", state, registry);
    expect(res).toEqual({
      kind: "error",
      message: "unknown slash command: /unknown",
    });
  });

  it("dispatches /help from idle state", async () => {
    const registry = buildDefaultRegistry();
    const state = createInitialState();
    const res = await dispatchSlashLine("/help", state, registry);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("/help");
      expect(res.text).toContain("/exit");
    }
  });

  it("rejects most commands from streaming state", async () => {
    const registry = buildDefaultRegistry();
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: "submit", text: "hi" });
    expect(s1.name).toBe("streaming");
    const res = await dispatchSlashLine("/help", s1, registry);
    expect(res.kind).toBe("error");
  });

  it("allows /stop from streaming state", async () => {
    const registry = buildDefaultRegistry();
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: "submit", text: "hi" });
    const res = await dispatchSlashLine("/stop", s1, registry);
    expect(res.kind).toBe("reducer-event");
  });

  it("rejects all commands from compact state", async () => {
    const registry = buildDefaultRegistry();
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: "submit", text: "hi" });
    const s2 = reduce(s1, { type: "compact-begin" });
    expect(s2.name).toBe("compact");
    for (const line of ["/help", "/stop", "/approve", "/exit"]) {
      const res = await dispatchSlashLine(line, s2, registry);
      expect(res.kind).toBe("error");
    }
  });

  it("rejects /resume from streaming state (per-command override)", async () => {
    const registry = buildDefaultRegistry();
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: "submit", text: "hi" });
    const res = await dispatchSlashLine("/resume abc", s1, registry);
    expect(res.kind).toBe("error");
  });

  it("allows /approve in awaiting-permission", async () => {
    const registry = buildDefaultRegistry();
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: "submit", text: "hi" });
    const s2 = reduce(s1, {
      type: "permission-request",
      request: { toolName: "bash", toolUseId: "t-1", input: {} },
    });
    const res = await dispatchSlashLine("/approve", s2, registry);
    expect(res.kind).toBe("reducer-event");
  });

  it("passes args through to the command", async () => {
    const registry = buildDefaultRegistry();
    const state = createInitialState();
    let currentModel = "claude-sonnet-4-6";
    const res = await dispatchSlashLine(
      "/model opus",
      state,
      registry,
      {
        getModel: () => currentModel,
        setModel: (m) => {
          currentModel = m;
        },
      },
    );
    expect(res.kind).toBe("message");
    expect(currentModel).toBe("opus");
  });

  it("wraps thrown errors from a command into error results", async () => {
    const boomCmd = {
      name: "boom",
      description: "throws",
      execute: () => {
        throw new Error("kaboom");
      },
    };
    const registry = {
      list: () => [{ name: "boom", description: "throws" }],
      get: (n: string) => (n === "boom" ? boomCmd : undefined),
    };
    const res = await dispatchSlashLine(
      "/boom",
      createInitialState(),
      registry,
    );
    expect(res).toEqual({
      kind: "error",
      message: "/boom failed: kaboom",
    });
  });
});

describe("buildDefaultRegistry", () => {
  it("returns all 15 commands", () => {
    const registry = buildDefaultRegistry();
    const names = registry.list().map((c) => c.name);
    expect(names).toEqual([
      "help",
      "exit",
      "clear",
      "status",
      "cost",
      "model",
      "permissions",
      "resume",
      "doctor",
      "tasks",
      "approve",
      "deny",
      "stop",
      "compact",
      "plugin",
    ]);
    expect(names).toHaveLength(15);
  });

  it("get() returns the matching command", () => {
    const registry = buildDefaultRegistry();
    expect(registry.get("help")?.name).toBe("help");
    expect(registry.get("nonexistent")).toBeUndefined();
  });
});
