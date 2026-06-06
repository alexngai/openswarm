import { describe, it, expect, afterEach } from "vitest";
import { skillSaveTool } from "./skill_save.js";
import { resetSkillStore } from "../../memory/skills.js";
import type { ToolExecutionContext } from "../types.js";

afterEach(() => {
  resetSkillStore();
});

function ctx(): ToolExecutionContext {
  return { cwd: "/tmp" };
}

describe("skillSaveTool", () => {
  it("has correct spec", () => {
    expect(skillSaveTool.spec.name).toBe("skill_save");
    expect(skillSaveTool.spec.tier).toBe(0);
    expect(skillSaveTool.spec.requiredPermission).toBe("none");
  });

  it("saves a skill", async () => {
    const result = await skillSaveTool.execute(
      {
        action: "save",
        name: "deploy-staging",
        tags: ["deploy", "ci"],
        content: "1. Build\n2. Push\n3. Verify",
      },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain('Skill "deploy-staging" saved');
      expect(result.output).toContain("deploy-staging");
      expect(result.output).toContain("Build");
    }
  });

  it("lists skills", async () => {
    await skillSaveTool.execute(
      { action: "save", name: "skill-a", tags: ["a"], content: "A" },
      ctx(),
    );
    await skillSaveTool.execute(
      { action: "save", name: "skill-b", tags: ["b"], content: "B" },
      ctx(),
    );

    const result = await skillSaveTool.execute(
      { action: "list" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("skill-a");
      expect(result.output).toContain("skill-b");
    }
  });

  it("lists empty skills", async () => {
    const result = await skillSaveTool.execute(
      { action: "list" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("No skills saved");
    }
  });

  it("gets a specific skill", async () => {
    await skillSaveTool.execute(
      { action: "save", name: "my-skill", tags: ["test"], content: "Do the thing" },
      ctx(),
    );

    const result = await skillSaveTool.execute(
      { action: "get", name: "my-skill" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("## Skill: my-skill");
      expect(result.output).toContain("Do the thing");
    }
  });

  it("returns error for missing skill", async () => {
    const result = await skillSaveTool.execute(
      { action: "get", name: "nope" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("removes a skill", async () => {
    await skillSaveTool.execute(
      { action: "save", name: "temp", tags: [], content: "temp" },
      ctx(),
    );
    const result = await skillSaveTool.execute(
      { action: "remove", name: "temp" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("removed");
    }

    const getResult = await skillSaveTool.execute(
      { action: "get", name: "temp" },
      ctx(),
    );
    expect(getResult.status).toBe("error");
  });

  it("rejects save without name", async () => {
    const result = await skillSaveTool.execute(
      { action: "save", content: "test" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("rejects save without content", async () => {
    const result = await skillSaveTool.execute(
      { action: "save", name: "test" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("rejects content exceeding size limit", async () => {
    const result = await skillSaveTool.execute(
      {
        action: "save",
        name: "too-big",
        content: "x".repeat(1001),
      },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("1000");
    }
  });

  it("overwrites existing skill on save", async () => {
    await skillSaveTool.execute(
      { action: "save", name: "my-skill", tags: ["v1"], content: "Version 1" },
      ctx(),
    );
    const result = await skillSaveTool.execute(
      { action: "save", name: "my-skill", tags: ["v2"], content: "Version 2" },
      ctx(),
    );
    expect(result.status).toBe("ok");

    const getResult = await skillSaveTool.execute(
      { action: "get", name: "my-skill" },
      ctx(),
    );
    expect(getResult.status).toBe("ok");
    if (getResult.status === "ok") {
      expect(getResult.output).toContain("Version 2");
      expect(getResult.output).not.toContain("Version 1");
    }
  });

  it("has concurrencySafe set to false", () => {
    expect(skillSaveTool.spec.concurrencySafe).toBe(false);
  });

  it("rejects invalid name format", async () => {
    const result = await skillSaveTool.execute(
      { action: "save", name: "invalid name!", content: "test" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });
});
