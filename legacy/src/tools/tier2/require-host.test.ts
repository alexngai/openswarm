import { describe, it, expect } from "vitest";
import type { ToolExecutionContext } from "../types.js";
import { requireHost } from "./require-host.js";
import { makeFakeHost } from "./_fake-host.js";

describe("requireHost", () => {
  it("returns the host when ctx.host is present", () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    expect(requireHost(ctx, "x")).toBe(host);
  });

  it("throws with the tool name and guidance when ctx.host is absent", () => {
    const ctx: ToolExecutionContext = { cwd: "/tmp" };
    expect(() => requireHost(ctx, "agent")).toThrow(/agent requires SwarmHost/);
    expect(() => requireHost(ctx, "task_create")).toThrow(
      /task_create requires SwarmHost/,
    );
  });
});
