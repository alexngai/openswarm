import { describe, it, expect, vi } from "vitest";
import { resolveConflictTool } from "./resolve_conflict.js";
import type { ToolExecutionContext } from "../types.js";

function ctxWith(
  host: Record<string, unknown> | undefined,
): ToolExecutionContext {
  return { host } as unknown as ToolExecutionContext;
}

describe("resolve_conflict tool", () => {
  it("calls host.resolveConflict with the conflictId and commit", async () => {
    const resolveConflict = vi.fn();
    const r = await resolveConflictTool.execute(
      { conflictId: "c1", resolutionCommit: "abc" },
      ctxWith({ resolveConflict }),
    );
    expect(resolveConflict).toHaveBeenCalledWith("c1", { resolutionCommit: "abc" });
    expect(r.status).toBe("ok");
    expect((r as { output: string }).output).toContain('"resolved":true');
  });

  it("omits opts when no resolutionCommit is given", async () => {
    const resolveConflict = vi.fn();
    await resolveConflictTool.execute({ conflictId: "c1" }, ctxWith({ resolveConflict }));
    expect(resolveConflict).toHaveBeenCalledWith("c1", undefined);
  });

  it("errors when the host has no resolveConflict support", async () => {
    const r = await resolveConflictTool.execute({ conflictId: "c1" }, ctxWith({}));
    expect(r.status).toBe("error");
    expect((r as { message: string }).message).toMatch(/not supported/);
  });

  it("throws when no host is present", async () => {
    await expect(
      resolveConflictTool.execute({ conflictId: "c1" }, ctxWith(undefined)),
    ).rejects.toThrow(/requires SwarmHost/);
  });

  it("rejects invalid input without touching the host", async () => {
    const resolveConflict = vi.fn();
    const r = await resolveConflictTool.execute(
      { conflictId: "" },
      ctxWith({ resolveConflict }),
    );
    expect(r.status).toBe("error");
    expect(resolveConflict).not.toHaveBeenCalled();
  });
});
