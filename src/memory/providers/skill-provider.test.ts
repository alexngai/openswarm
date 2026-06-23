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
  delete process.env.SWARM_HARNESS_SKILLS_DIR;
});

describe("resolveSkillsDir", () => {
  it("uses an explicit override", () => {
    expect(resolveSkillsDir("/custom/skills")).toBe("/custom/skills");
  });

  it("uses SWARM_HARNESS_SKILLS_DIR when no override", () => {
    process.env.SWARM_HARNESS_SKILLS_DIR = "/env/skills";
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
});
