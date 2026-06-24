/**
 * End-to-end surfacing test: drives the REAL memory lifecycle (coordinator +
 * SkillProvider, no mocks, no LLM) to prove a skill on disk is surfaced into a
 * turn via onSessionStart -> onBeforeTurn -> formatMemoryFragments.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onSessionStart, onBeforeTurn, formatMemoryFragments } from "./lifecycle.js";
import { resetMemoryCoordinator } from "./coordinator.js";

let tmpDir: string | undefined;

afterEach(async () => {
  await resetMemoryCoordinator();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  delete process.env.SWARM_HARNESS_SKILLS_DIR;
});

describe("memory surfacing (lifecycle e2e)", () => {
  it("surfaces a filesystem skill through onSessionStart -> onBeforeTurn", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-surface-"));

    // Seed the store the way the ecosystem does: skill-tree's filesystem adapter.
    const mod = (await import("skill-tree")) as unknown as {
      FilesystemStorageAdapter: new (c: { basePath: string }) => {
        initialize(): Promise<void>;
        saveSkill(s: Record<string, unknown>): Promise<void>;
      };
    };
    const writer = new mod.FilesystemStorageAdapter({ basePath: tmpDir });
    await writer.initialize();
    await writer.saveSkill({
      id: "db-migrate",
      name: "Run DB Migration",
      version: "1.0.0",
      description: "How to run prisma migrations safely",
      instructions: "npx prisma migrate deploy",
      author: "test",
      tags: ["database", "prisma"],
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    process.env.SWARM_HARNESS_SKILLS_DIR = tmpDir;

    // The real lifecycle: register providers, then enrich a turn.
    await onSessionStart({ agentId: "test-agent" });
    const fragments = await onBeforeTurn({ query: "prisma" });

    const skillFragment = fragments.find((f) => f.source.startsWith("skill:"));
    expect(skillFragment).toBeDefined();
    expect(skillFragment!.source).toBe("skill:db-migrate");
    expect(skillFragment!.content).toContain("Run DB Migration");

    const block = formatMemoryFragments(fragments);
    expect(block).not.toBeNull();
    expect(block).toContain("Run DB Migration");
    expect(block).toContain("npx prisma migrate deploy");
  });

  it("surfaces nothing (and never throws) when no skills dir exists", async () => {
    process.env.SWARM_HARNESS_SKILLS_DIR = path.join(os.tmpdir(), "definitely-absent-xyz");
    await onSessionStart({ agentId: "test-agent" });
    const fragments = await onBeforeTurn({ query: "prisma" });
    expect(fragments.find((f) => f.source.startsWith("skill:"))).toBeUndefined();
  });
});
