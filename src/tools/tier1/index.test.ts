import { describe, it, expect } from "vitest";
import { buildTier1Tools } from "./index.js";
import type { SkillRegistry } from "../../skills/index.js";

const mockRegistry: SkillRegistry = {
  register: () => {},
  discover: async () => [],
  load: async () => {
    throw new Error("not implemented in mock");
  },
};

describe("buildTier1Tools", () => {
  it("returns exactly 3 tools when no registry is provided", () => {
    const tools = buildTier1Tools({});
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.spec.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    expect(names).toContain("skill");
  });

  it("returns exactly 3 tools when skillRegistry is provided", () => {
    const tools = buildTier1Tools({ skillRegistry: mockRegistry });
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.spec.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    expect(names).toContain("skill");
  });
});
