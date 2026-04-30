import { describe, it, expect } from "vitest";
import { webSearchTool } from "./web_search.js";
import type { ToolExecutionContext } from "../types.js";

function ctx(): ToolExecutionContext {
  return { cwd: "/tmp" };
}

describe("webSearchTool (placeholder)", () => {
  it("execute always returns the SDK misconfiguration error message", async () => {
    const result = await webSearchTool.execute({ query: "test query" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("web_search should be handled by the SDK built-in");
      expect(result.message).toContain("RunConfig.enabledBuiltinTools");
    }
  });
});
