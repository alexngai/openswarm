import { describe, it, expect } from "vitest";
import { buildSkillTool } from "./skill.js";
import type { ToolExecutionContext } from "../types.js";
import type { SkillRegistry, LoadedSkill } from "../../skills/index.js";

function ctx(): ToolExecutionContext {
  return { cwd: "/tmp" };
}

function mockRegistry(skills: Record<string, LoadedSkill | undefined>): SkillRegistry {
  return {
    register: () => {},
    discover: async () => [],
    async load(skillId: string) {
      const skill = skills[skillId];
      if (!skill) throw new Error(`skill '${skillId}' not found`);
      return skill;
    },
  };
}

function makeSkill(id: string, body: string): LoadedSkill {
  return {
    manifest: {
      id,
      name: id,
      sourceId: "test",
      filePath: `/tmp/${id}.md`,
    },
    body,
  };
}

describe("buildSkillTool", () => {
  it("returns error when no registry is configured", async () => {
    const tool = buildSkillTool(undefined);
    const result = await tool.execute({ id: "some-skill" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("skills not configured");
      expect(result.message).toContain("SkillRegistry unavailable");
    }
  });

  it("returns error when skill id is not found in registry", async () => {
    const registry = mockRegistry({});
    const tool = buildSkillTool(registry);
    const result = await tool.execute({ id: "nonexistent" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("skill load failed");
    }
  });

  it("returns the skill body on happy path", async () => {
    const registry = mockRegistry({
      "my-skill": makeSkill("my-skill", "# My Skill\nDo the thing."),
    });
    const tool = buildSkillTool(registry);
    const result = await tool.execute({ id: "my-skill" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("# My Skill");
      expect(result.output).toContain("Do the thing.");
    }
  });

  it("returns error on invalid input", async () => {
    const tool = buildSkillTool(undefined);
    const result = await tool.execute({ id: 42 }, ctx());
    expect(result.status).toBe("error");
  });
});
