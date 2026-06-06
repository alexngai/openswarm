import { describe, it, expect } from "vitest";
import {
  parseMentions,
  resolveMentions,
  stripMentions,
} from "./mention-syntax.js";

describe("parseMentions", () => {
  it("parses @tool mentions", () => {
    const result = parseMentions("Use @bash to run the command");
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("tool");
    expect(result[0]!.name).toBe("bash");
  });

  it("parses @plugin:tool mentions", () => {
    const result = parseMentions("Call @mcp:github_search");
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("plugin");
    expect(result[0]!.name).toBe("github_search");
    expect(result[0]!.namespace).toBe("mcp");
  });

  it("parses multiple mentions", () => {
    const result = parseMentions("Use @read_file then @write_file");
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("read_file");
    expect(result[1]!.name).toBe("write_file");
  });

  it("handles mentions at start of text", () => {
    const result = parseMentions("@bash is useful");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("bash");
  });

  it("handles mentions at end of text", () => {
    const result = parseMentions("Try using @grep");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("grep");
  });

  it("handles mentions followed by punctuation", () => {
    const result = parseMentions("Use @bash, @grep, and @read_file.");
    expect(result).toHaveLength(3);
  });

  it("ignores email addresses", () => {
    const result = parseMentions("Email me at user@example.com");
    expect(result).toHaveLength(0);
  });

  it("returns empty for no mentions", () => {
    const result = parseMentions("No mentions here");
    expect(result).toHaveLength(0);
  });

  it("captures correct indices", () => {
    const text = "Use @bash here";
    const result = parseMentions(text);
    expect(result[0]!.startIndex).toBe(4);
    expect(result[0]!.endIndex).toBe(9);
    expect(text.slice(result[0]!.startIndex, result[0]!.endIndex)).toBe("@bash");
  });
});

describe("resolveMentions", () => {
  const tools = ["bash", "read_file", "grep"];
  const agents = ["researcher", "coder"];

  it("resolves tool mentions", () => {
    const result = resolveMentions("Use @bash", tools, agents);
    expect(result[0]!.type).toBe("tool");
  });

  it("resolves agent mentions", () => {
    const result = resolveMentions("Ask @researcher", tools, agents);
    expect(result[0]!.type).toBe("agent");
  });

  it("keeps plugin mentions as-is", () => {
    const result = resolveMentions("Use @mcp:tool", tools, agents);
    expect(result[0]!.type).toBe("plugin");
  });

  it("defaults to tool for unknown names", () => {
    const result = resolveMentions("Use @unknown_thing", tools, agents);
    expect(result[0]!.type).toBe("tool");
    expect(result[0]!.name).toBe("unknown_thing");
  });
});

describe("stripMentions", () => {
  it("removes all mentions", () => {
    expect(stripMentions("Use @bash to run @grep")).toBe("Use to run");
  });

  it("handles text with no mentions", () => {
    expect(stripMentions("No mentions")).toBe("No mentions");
  });

  it("handles plugin mentions", () => {
    expect(stripMentions("Call @mcp:tool now")).toBe("Call now");
  });
});
