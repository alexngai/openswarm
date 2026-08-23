import { describe, it, expect } from "vitest";
import {
  fingerprintSystemPrompt,
  capturePrefixShape,
  comparePrefixShapes,
} from "./prompt-cache.js";
import type { ToolSpec } from "../core/types.js";

function makeTool(name: string): ToolSpec {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: { arg: { type: "string" } } },
    requiredPermission: "none",
    tier: 0,
  };
}

describe("fingerprintSystemPrompt", () => {
  it("returns version v1", () => {
    const fp = fingerprintSystemPrompt("hello", []);
    expect(fp.version).toBe("v1");
  });

  it("returns 16-char hex hash", () => {
    const fp = fingerprintSystemPrompt("hello", []);
    expect(fp.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable: same inputs produce same hash", () => {
    const tools = [makeTool("read_file"), makeTool("bash")];
    const fp1 = fingerprintSystemPrompt("prefix", tools);
    const fp2 = fingerprintSystemPrompt("prefix", tools);
    expect(fp1.hash).toBe(fp2.hash);
  });

  it("changes when tool list changes", () => {
    const fp1 = fingerprintSystemPrompt("prefix", [makeTool("read_file")]);
    const fp2 = fingerprintSystemPrompt("prefix", [makeTool("bash")]);
    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it("changes when prefix changes", () => {
    const tools = [makeTool("read_file")];
    const fp1 = fingerprintSystemPrompt("prefix-A", tools);
    const fp2 = fingerprintSystemPrompt("prefix-B", tools);
    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it("is stable when tool list is reordered (sorted by name internally)", () => {
    const tools1 = [makeTool("bash"), makeTool("read_file"), makeTool("write_file")];
    const tools2 = [makeTool("write_file"), makeTool("bash"), makeTool("read_file")];
    const fp1 = fingerprintSystemPrompt("prefix", tools1);
    const fp2 = fingerprintSystemPrompt("prefix", tools2);
    expect(fp1.hash).toBe(fp2.hash);
  });

  it("is stable across semver-equivalent schema rewrites — hash is based on {name, description} only (M4)", () => {
    // Two tools with identical name+description but different inputSchema shapes.
    // Fingerprint must be identical: schema churn (Zod key-ordering, $defs
    // insertion, etc.) must not invalidate analytics cache_hit events.
    const tool1: ToolSpec = {
      name: "read_file",
      description: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      requiredPermission: "read",
      tier: 1,
    };
    const tool2: ToolSpec = {
      ...tool1,
      // Different schema shape — same name & description.
      inputSchema: { type: "object", properties: { file: { type: "string" } } },
    };
    const fp1 = fingerprintSystemPrompt("prefix", [tool1]);
    const fp2 = fingerprintSystemPrompt("prefix", [tool2]);
    expect(fp1.hash).toBe(fp2.hash);
  });

  it("changes when tool description changes (M4)", () => {
    const tool1: ToolSpec = {
      name: "read_file",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      requiredPermission: "read",
      tier: 1,
    };
    const tool2: ToolSpec = {
      ...tool1,
      description: "read a file from disk",
    };
    const fp1 = fingerprintSystemPrompt("prefix", [tool1]);
    const fp2 = fingerprintSystemPrompt("prefix", [tool2]);
    expect(fp1.hash).not.toBe(fp2.hash);
  });
});

describe("capturePrefixShape / comparePrefixShapes (docs/55 TE-21)", () => {
  it("combined hash is byte-compatible with fingerprintSystemPrompt", () => {
    const tools = [makeTool("a"), makeTool("b")];
    const shape = capturePrefixShape("prefix", tools);
    const fp = fingerprintSystemPrompt("prefix", tools);
    expect(shape.hash).toBe(fp.hash);
    expect(shape.version).toBe("v1");
  });

  it("is deterministic per component", () => {
    const tools = [makeTool("a")];
    const s1 = capturePrefixShape("prefix", tools);
    const s2 = capturePrefixShape("prefix", tools);
    expect(s1).toEqual(s2);
  });

  it("names 'system' when only the prompt changed", () => {
    const tools = [makeTool("a")];
    const prev = capturePrefixShape("prefix v1", tools);
    const cur = capturePrefixShape("prefix v2", tools);
    expect(comparePrefixShapes(prev, cur)).toEqual(["system"]);
  });

  it("names 'tools' when only the tool surface changed", () => {
    const prev = capturePrefixShape("prefix", [makeTool("a")]);
    const cur = capturePrefixShape("prefix", [makeTool("a"), makeTool("b")]);
    expect(comparePrefixShapes(prev, cur)).toEqual(["tools"]);
  });

  it("names both when both changed, empty when nothing changed", () => {
    const prev = capturePrefixShape("prefix v1", [makeTool("a")]);
    const cur = capturePrefixShape("prefix v2", [makeTool("b")]);
    expect(comparePrefixShapes(prev, cur)).toEqual(["system", "tools"]);
    expect(comparePrefixShapes(prev, prev)).toEqual([]);
  });

  it("tool reorder does not change the tools hash (sorted internally)", () => {
    const prev = capturePrefixShape("prefix", [makeTool("a"), makeTool("b")]);
    const cur = capturePrefixShape("prefix", [makeTool("b"), makeTool("a")]);
    expect(comparePrefixShapes(prev, cur)).toEqual([]);
  });
});
