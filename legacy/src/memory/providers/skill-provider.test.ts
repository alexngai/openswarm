import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillProvider, resolveSkillsDir } from "./skill-provider.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  delete process.env.OPENSWARM_SKILLS_DIR;
});

describe("resolveSkillsDir", () => {
  it("uses an explicit override", () => {
    expect(resolveSkillsDir("/custom/skills")).toBe("/custom/skills");
  });

  it("uses OPENSWARM_SKILLS_DIR when no override", () => {
    process.env.OPENSWARM_SKILLS_DIR = "/env/skills";
    expect(resolveSkillsDir()).toBe("/env/skills");
  });

  it("falls back to a non-empty default path", () => {
    const dir = resolveSkillsDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });
});

describe("SkillProvider", () => {
  it("is unavailable when the skills dir does not exist", async () => {
    const provider = new SkillProvider();
    await provider.initialize({ skillsDir: path.join(os.tmpdir(), "does-not-exist-xyz-123") });
    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.enrichTurn({ query: "deploy" })).toEqual([]);
  });

  it("does not activate on (or write into) a non-bank directory", async () => {
    // A directory that exists but is NOT a skill-tree bank — e.g.
    // OPENSWARM_SKILLS_DIR mispointed at a Claude-style skills dir.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prov-"));
    fs.mkdirSync(path.join(tmpDir, "some-claude-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "some-claude-skill", "SKILL.md"),
      "---\nname: x\ndescription: y\n---\nbody\n",
    );

    const provider = new SkillProvider();
    await provider.initialize({ skillsDir: tmpDir });

    expect(await provider.isAvailable()).toBe(false);
    // Crucially, the adapter must not have been initialized against it —
    // that would mkdir `.skilltree/` clutter inside the user's directory.
    expect(fs.existsSync(path.join(tmpDir, ".skilltree"))).toBe(false);
  });

  it("surfaces matching skills from a filesystem store", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prov-"));

    // Seed the store the same way the ecosystem does: skill-tree's filesystem adapter.
    const mod = (await import("skill-tree")) as unknown as {
      FilesystemStorageAdapter: new (c: { basePath: string }) => {
        initialize(): Promise<void>;
        saveSkill(s: Record<string, unknown>): Promise<void>;
      };
    };
    const writer = new mod.FilesystemStorageAdapter({ basePath: tmpDir });
    await writer.initialize();
    await writer.saveSkill({
      id: "deploy-web",
      name: "Deploy Web",
      version: "1.0.0",
      description: "How to deploy the web app",
      instructions: "Run npm build then ship",
      author: "test",
      tags: ["deploy", "web"],
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const provider = new SkillProvider();
    await provider.initialize({ skillsDir: tmpDir });
    expect(await provider.isAvailable()).toBe(true);

    const fragments = await provider.enrichTurn({ query: "deploy" });
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments[0]!.source).toBe("skill:deploy-web");
    expect(fragments[0]!.content).toContain("Deploy Web");
    expect(fragments[0]!.content).toContain("Run npm build then ship");
  });

  it("returns [] for an empty query", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prov-"));
    const provider = new SkillProvider();
    await provider.initialize({ skillsDir: tmpDir });
    expect(await provider.enrichTurn({})).toEqual([]);
  });

  it("falls back to token-overlap ranking for long natural-language prompts", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prov-"));

    const mod = (await import("skill-tree")) as unknown as {
      FilesystemStorageAdapter: new (c: { basePath: string }) => {
        initialize(): Promise<void>;
        saveSkill(s: Record<string, unknown>): Promise<void>;
      };
    };
    const writer = new mod.FilesystemStorageAdapter({ basePath: tmpDir });
    await writer.initialize();
    const base = {
      version: "1.0.0",
      author: "test",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await writer.saveSkill({
      ...base,
      id: "reuse-helpers",
      name: "reuse-existing-helpers",
      description: "Compose new functions from existing helpers instead of duplicating logic",
      instructions: "Call the existing function and transform its result",
      tags: ["javascript", "reuse"],
    });
    await writer.saveSkill({
      ...base,
      id: "db-migrations",
      name: "safe-db-migrations",
      description: "Run database migrations with a rollback plan",
      instructions: "Snapshot, migrate, verify",
      tags: ["database"],
    });

    const provider = new SkillProvider();
    await provider.initialize({ skillsDir: tmpDir });

    // Long prompt: BM25's all-terms requirement can't match, the overlap
    // fallback should still surface the relevant skill (and not the other).
    const fragments = await provider.enrichTurn({
      query:
        "In math.js, add an exported wrapper function that reuses the existing add function and returns the sum in uppercase words style",
    });
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments[0]!.source).toBe("skill:reuse-helpers");
    expect(fragments.map((f) => f.source)).not.toContain("skill:db-migrations");
  });
});

describe("rankByTokenOverlap", () => {
  const skill = (over: Partial<Record<string, unknown>>) => ({
    id: "s1",
    name: "",
    description: "",
    instructions: "",
    tags: [] as string[],
    ...over,
  });

  it("weights name/tag hits above description and body hits", async () => {
    const { rankByTokenOverlap } = await import("./skill-provider.js");
    const byName = skill({ id: "by-name", name: "deploy pipeline" });
    const byBody = skill({ id: "by-body", instructions: "deploy the pipeline carefully" });
    const ranked = rankByTokenOverlap([byBody, byName] as never, "deploy pipeline");
    expect(ranked.map((s) => s.id)).toEqual(["by-name", "by-body"]);
  });

  it("drops zero-overlap skills and empty queries", async () => {
    const { rankByTokenOverlap } = await import("./skill-provider.js");
    const s = skill({ id: "s", name: "unrelated topic" });
    expect(rankByTokenOverlap([s] as never, "database migration")).toEqual([]);
    expect(rankByTokenOverlap([s] as never, "a b")).toEqual([]);
  });
});
