import { afterEach, describe, expect, it } from "vitest";
import {
  clearGuardRegistry,
  defineGuardTool,
  setGuardRegistry,
} from "./define_guard.js";
import { GuardRegistry } from "../../harness/guards.js";
import type { ToolExecutionContext } from "../types.js";

const ctx: ToolExecutionContext = { cwd: "/tmp" };

const defineInput = {
  action: "define" as const,
  target_tool: "edit_file",
  predicate: { kind: "field_length_lt" as const, field: "old_string", length: 10 },
  message: "include surrounding context",
  failure_signature: "ambiguous-old-string",
};

afterEach(() => {
  clearGuardRegistry();
});

describe("define_guard", () => {
  it("errors cleanly when no registry is wired", async () => {
    const res = await defineGuardTool.execute(defineInput, ctx);
    expect(res.status).toBe("error");
    expect(res.status === "error" && res.message).toContain("not available");
  });

  it("installs a guard that the registry then enforces", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);

    const res = await defineGuardTool.execute(defineInput, ctx);
    expect(res.status).toBe("ok");
    expect(res.status === "ok" && res.output).toContain("installed on edit_file");
    // Reports the statically-derived touched set (docs/64 §5.3).
    expect(res.status === "ok" && res.output).toContain("old_string");

    expect(reg.list()).toHaveLength(1);
    expect(reg.evaluate("edit_file", { old_string: "x" }).blocked).toBe(true);
  });

  it("marks every installed guard restrictive", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);
    await defineGuardTool.execute(defineInput, ctx);
    expect(reg.list()[0]?.effect).toBe("restrictive");
  });

  it("is idempotent — re-defining the same guard does not duplicate it", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);

    await defineGuardTool.execute(defineInput, ctx);
    const second = await defineGuardTool.execute(defineInput, ctx);

    expect(second.status).toBe("ok");
    expect(second.status === "ok" && second.output).toContain("already installed");
    expect(reg.list()).toHaveLength(1);
  });

  it("lists guards with their evidence", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);
    await defineGuardTool.execute(defineInput, ctx);
    reg.evaluate("edit_file", { old_string: "x" });

    const res = await defineGuardTool.execute({ action: "list" }, ctx);
    expect(res.status).toBe("ok");
    expect(res.status === "ok" && res.output).toContain("ambiguous-old-string");
    expect(res.status === "ok" && res.output).toContain("fired=1");
  });

  it("reports an empty list before anything is installed", async () => {
    setGuardRegistry(new GuardRegistry());
    const res = await defineGuardTool.execute({ action: "list" }, ctx);
    expect(res.status).toBe("ok");
    expect(res.status === "ok" && res.output).toContain("No guards");
  });

  it("removes a guard by id", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);
    await defineGuardTool.execute(defineInput, ctx);
    const id = reg.list()[0]!.id;

    const res = await defineGuardTool.execute({ action: "remove", guard_id: id }, ctx);
    expect(res.status).toBe("ok");
    expect(reg.list()).toHaveLength(0);
  });

  it("errors on removing an unknown guard", async () => {
    setGuardRegistry(new GuardRegistry());
    const res = await defineGuardTool.execute({ action: "remove", guard_id: "nope" }, ctx);
    expect(res.status).toBe("error");
  });

  it("rejects malformed input", async () => {
    setGuardRegistry(new GuardRegistry());
    const res = await defineGuardTool.execute({ action: "define", target_tool: "" }, ctx);
    expect(res.status).toBe("error");
  });

  it("accepts a composed predicate", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);

    const res = await defineGuardTool.execute(
      {
        ...defineInput,
        predicate: {
          kind: "all",
          of: [
            { kind: "field_matches", field: "file_path", pattern: "\\.generated\\.ts$" },
            { kind: "not", of: { kind: "field_absent", field: "old_string" } },
          ],
        },
      },
      ctx,
    );

    expect(res.status).toBe("ok");
    expect(
      reg.evaluate("edit_file", { file_path: "a.generated.ts", old_string: "x" }).blocked,
    ).toBe(true);
    expect(reg.evaluate("edit_file", { file_path: "a.ts", old_string: "x" }).blocked).toBe(false);
  });

  it("rejects an over-broad guard that would block a recent successful call (§10.4 gate)", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);
    // A normal successful edit happened earlier this session.
    reg.recordSuccess("edit_file", { file_path: "a.ts", old_string: "abc", new_string: "xyz" });

    // An over-broad guard: matches any edit with a non-empty old_string.
    const res = await defineGuardTool.execute(
      {
        action: "define",
        target_tool: "edit_file",
        predicate: { kind: "field_matches", field: "old_string", pattern: "." },
        message: "too restrictive",
        failure_signature: "over-broad",
      },
      ctx,
    );

    expect(res.status).toBe("error");
    expect(res.status === "error" && res.message).toContain("too broad");
    expect(res.status === "error" && res.message).toContain("Narrow the predicate");
    // Critically: it was NOT installed.
    expect(reg.list()).toHaveLength(0);
  });

  it("installs a narrow guard even when successes exist", async () => {
    const reg = new GuardRegistry();
    setGuardRegistry(reg);
    reg.recordSuccess("edit_file", { file_path: "a.ts", old_string: "unique", new_string: "y" });

    const res = await defineGuardTool.execute(
      {
        ...defineInput,
        predicate: { kind: "field_matches", field: "old_string", pattern: "^statuses\\.push\\(0\\);$" },
      },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(reg.list()).toHaveLength(1);
  });
});
