import { describe, it, expect, beforeEach } from "vitest";
import { toolSearchTool, setToolRegistry } from "./tool_search.js";
import type { ToolSpec } from "../../core/types.js";
import type { ToolExecutionContext } from "../types.js";

const ctx = (): ToolExecutionContext => ({ cwd: "/tmp" });

const mockTools: ToolSpec[] = [
  { name: "bash", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } }, requiredPermission: "exec", tier: 0 },
  { name: "read_file", description: "Read a file from the filesystem", inputSchema: { type: "object", properties: { path: { type: "string" } } }, requiredPermission: "read", tier: 0 },
  { name: "write_file", description: "Write content to a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }, requiredPermission: "write", tier: 0 },
  { name: "web_fetch", description: "Fetch a URL and return content", inputSchema: { type: "object", properties: { url: { type: "string" } } }, requiredPermission: "network", tier: 1 },
  { name: "grep", description: "Search for patterns in files", inputSchema: { type: "object", properties: { pattern: { type: "string" } } }, requiredPermission: "read", tier: 0 },
];

beforeEach(() => {
  setToolRegistry(mockTools);
});

describe("tool_search", () => {
  it("has correct spec", () => {
    expect(toolSearchTool.spec.name).toBe("tool_search");
    expect(toolSearchTool.spec.requiredPermission).toBe("none");
  });

  it("finds tools by exact name", async () => {
    const result = await toolSearchTool.execute({ query: "bash" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toContain("**bash**");
  });

  it("finds tools by description keyword", async () => {
    const result = await toolSearchTool.execute({ query: "file" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toContain("read_file");
    expect(result.output).toContain("write_file");
  });

  it("returns no matches message for unknown query", async () => {
    const result = await toolSearchTool.execute({ query: "xyznonexistent" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toContain("No tools found");
    expect(result.output).toContain("Available tools");
  });

  it("limits results", async () => {
    const result = await toolSearchTool.execute(
      { query: "a", maxResults: 2 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const toolMatches = result.output.match(/\*\*\w+\*\*/g) ?? [];
    expect(toolMatches.length).toBeLessThanOrEqual(2);
  });

  it("includes tool metadata in results", async () => {
    const result = await toolSearchTool.execute({ query: "bash" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toContain("tier 0");
    expect(result.output).toContain("exec");
  });

  it("rejects invalid input", async () => {
    const result = await toolSearchTool.execute({}, ctx());
    expect(result.status).toBe("error");
  });
});
