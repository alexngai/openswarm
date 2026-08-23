import { describe, it, expect } from "vitest";
import { SkillRegistry } from "./registry.js";
import type { SkillSource, SkillManifest, LoadedSkill } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(id: string, description = "Test skill", triggers?: string[]): SkillManifest {
  return {
    id,
    name: id,
    description,
    sourceId: "test",
    filePath: `/tmp/${id}.md`,
    triggers,
  };
}

function makeLoaded(id: string, body: string): LoadedSkill {
  return { manifest: makeManifest(id), body };
}

function makeSource(id: string, skills: Map<string, LoadedSkill>): SkillSource {
  return {
    id,
    async discover(): Promise<readonly SkillManifest[]> {
      return Array.from(skills.values()).map((s) => s.manifest);
    },
    async load(skillId: string): Promise<LoadedSkill | undefined> {
      return skills.get(skillId);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillRegistry", () => {
  it("discover() returns empty when no sources registered", async () => {
    const registry = new SkillRegistry();
    const manifests = await registry.discover();
    expect(manifests).toHaveLength(0);
  });

  it("registerSource() + discover() unions skills across sources", async () => {
    const registry = new SkillRegistry();
    const source1 = makeSource("s1", new Map([["skill-a", makeLoaded("skill-a", "body-a")]]));
    const source2 = makeSource("s2", new Map([["skill-b", makeLoaded("skill-b", "body-b")]]));
    registry.registerSource(source1);
    registry.registerSource(source2);

    const manifests = await registry.discover();
    expect(manifests.map((m) => m.id)).toContain("skill-a");
    expect(manifests.map((m) => m.id)).toContain("skill-b");
  });

  it("discover() first-wins across sources on id collision", async () => {
    const registry = new SkillRegistry();
    const s1Skills = new Map([
      ["shared", makeLoaded("shared", "from-source-1")],
    ]);
    const s2Skills = new Map([
      ["shared", makeLoaded("shared", "from-source-2")],
    ]);
    // Override manifest descriptions to be distinguishable.
    s1Skills.get("shared")!.manifest;
    const s1manifest: SkillManifest = { ...makeManifest("shared", "Source 1 description"), sourceId: "s1" };
    const s2manifest: SkillManifest = { ...makeManifest("shared", "Source 2 description"), sourceId: "s2" };

    const source1: SkillSource = {
      id: "s1",
      async discover() { return [s1manifest]; },
      async load(id) { return id === "shared" ? { manifest: s1manifest, body: "s1-body" } : undefined; },
    };
    const source2: SkillSource = {
      id: "s2",
      async discover() { return [s2manifest]; },
      async load(id) { return id === "shared" ? { manifest: s2manifest, body: "s2-body" } : undefined; },
    };

    registry.registerSource(source1);
    registry.registerSource(source2);

    const manifests = await registry.discover();
    const shared = manifests.filter((m) => m.id === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]!.description).toBe("Source 1 description");
  });

  it("load() delegates to the first source that has the skill", async () => {
    const registry = new SkillRegistry();
    const source1 = makeSource("s1", new Map()); // doesn't have it
    const source2 = makeSource("s2", new Map([["skill-x", makeLoaded("skill-x", "body-x")]]));
    registry.registerSource(source1);
    registry.registerSource(source2);

    const loaded = await registry.load("skill-x");
    expect(loaded.body).toBe("body-x");
  });

  it("load() throws when skill is not found in any source", async () => {
    const registry = new SkillRegistry();
    registry.registerSource(makeSource("s1", new Map()));

    await expect(registry.load("nonexistent")).rejects.toThrow("skill 'nonexistent' not found");
  });

  it("list() returns id/description/triggers from all discovered manifests", async () => {
    const registry = new SkillRegistry();
    const manifest = makeManifest("test-skill", "A test skill", ["trigger1"]);
    const source: SkillSource = {
      id: "s1",
      async discover() { return [manifest]; },
      async load() { return undefined; },
    };
    registry.registerSource(source);

    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("test-skill");
    expect(list[0]!.description).toBe("A test skill");
    expect(list[0]!.triggers).toEqual(["trigger1"]);
  });

  it("register() is an alias for registerSource()", async () => {
    const registry = new SkillRegistry();
    const source = makeSource("s1", new Map([["skill-y", makeLoaded("skill-y", "body-y")]]));
    registry.register(source);

    const manifests = await registry.discover();
    expect(manifests.map((m) => m.id)).toContain("skill-y");
  });

  it("load() first source wins when multiple sources have same id", async () => {
    const registry = new SkillRegistry();
    const s1: SkillSource = {
      id: "s1",
      async discover() { return [makeManifest("dup", "S1")]; },
      async load(id) { return id === "dup" ? { manifest: makeManifest("dup"), body: "s1-wins" } : undefined; },
    };
    const s2: SkillSource = {
      id: "s2",
      async discover() { return [makeManifest("dup", "S2")]; },
      async load(id) { return id === "dup" ? { manifest: makeManifest("dup"), body: "s2-body" } : undefined; },
    };
    registry.registerSource(s1);
    registry.registerSource(s2);

    const loaded = await registry.load("dup");
    expect(loaded.body).toBe("s1-wins");
  });
});
