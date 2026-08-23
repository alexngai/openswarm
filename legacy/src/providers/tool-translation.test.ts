import { describe, expect, it } from "vitest";
import { toolSpecsToVercelTools } from "./tool-translation.js";
import type { ToolSpec } from "../core/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleTools: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
    requiredPermission: "read",
    tier: 0,
  },
  {
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    requiredPermission: "write",
    tier: 1,
  },
  {
    name: "bash",
    description: "Execute a bash command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    requiredPermission: "exec",
    tier: 2,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toolSpecsToVercelTools", () => {
  it("returns an empty object for empty input", () => {
    const result = toolSpecsToVercelTools([]);
    expect(result).toEqual({});
  });

  it("includes all three tool names from fixtures", () => {
    const result = toolSpecsToVercelTools(sampleTools);
    expect(Object.keys(result)).toHaveLength(3);
    expect(Object.keys(result)).toContain("read_file");
    expect(Object.keys(result)).toContain("write_file");
    expect(Object.keys(result)).toContain("bash");
  });

  it("preserves tool descriptions", () => {
    const result = toolSpecsToVercelTools(sampleTools);
    expect(result["read_file"]!.description).toBe("Read the contents of a file");
    expect(result["write_file"]!.description).toBe("Write content to a file");
    expect(result["bash"]!.description).toBe("Execute a bash command");
  });

  it("each tool has an inputSchema field (jsonSchema-wrapped)", () => {
    const result = toolSpecsToVercelTools(sampleTools);
    for (const name of Object.keys(result)) {
      expect(result[name]).toHaveProperty("inputSchema");
      expect((result[name] as { inputSchema: unknown }).inputSchema).toBeDefined();
    }
  });

  it("does not set execute on any tool", () => {
    const result = toolSpecsToVercelTools(sampleTools);
    for (const name of Object.keys(result)) {
      expect(result[name]).not.toHaveProperty("execute");
    }
  });

  it("single tool round-trips name and description", () => {
    const single: ToolSpec[] = [
      {
        name: "my_tool",
        description: "Does something useful",
        inputSchema: { type: "object", properties: {}, required: [] },
        requiredPermission: "none",
        tier: 0,
      },
    ];
    const result = toolSpecsToVercelTools(single);
    expect(result["my_tool"]!.description).toBe("Does something useful");
  });
});
