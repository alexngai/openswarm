import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  onSessionStart,
  onBeforeTurn,
  onAfterTurn,
  onCompaction,
  onSessionEnd,
  formatMemoryFragments,
} from "./lifecycle.js";
import {
  getMemoryCoordinator,
  resetMemoryCoordinator,
} from "./coordinator.js";
import {
  executeCuratedAction,
  resetCuratedMemoryStore,
  resetCuratedMemoryLimits,
} from "./curated.js";
import {
  searchArchive,
  resetArchiveStore,
} from "./archive.js";
import type { MemoryFragment } from "./types.js";

beforeEach(() => {
  // Keep provider-registration tests deterministic: point the SkillProvider at
  // a non-existent dir so it stays unavailable (these tests cover file/minimem).
  process.env.OPENSWARM_SKILLS_DIR = "/nonexistent-skill-tree-dir-for-tests";
});

afterEach(async () => {
  delete process.env.OPENSWARM_SKILLS_DIR;
  await resetMemoryCoordinator();
  resetCuratedMemoryStore();
  resetCuratedMemoryLimits();
  resetArchiveStore();
});

// ---------------------------------------------------------------------------
// onSessionStart
// ---------------------------------------------------------------------------

describe("onSessionStart", () => {
  it("registers available memory providers", async () => {
    await onSessionStart();
    const coordinator = getMemoryCoordinator();
    expect(coordinator.providerNames).toContain("file");
    expect(coordinator.providerCount).toBeGreaterThanOrEqual(1);
  });

  it("does not duplicate providers", async () => {
    await onSessionStart();
    await onSessionStart();
    const coordinator = getMemoryCoordinator();
    expect(new Set(coordinator.providerNames).size).toBe(coordinator.providerCount);
    expect(coordinator.providerNames.filter((name) => name === "file")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onBeforeTurn
// ---------------------------------------------------------------------------

describe("onBeforeTurn", () => {
  it("returns empty fragments when no memory", async () => {
    await onSessionStart();
    const fragments = await onBeforeTurn({
      userId: "alice",
      projectRoot: "/project",
    });
    expect(fragments).toEqual([]);
  });

  it("returns curated memory fragments", async () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/project",
      entry: "Uses monorepo structure",
    });

    await onSessionStart();
    const fragments = await onBeforeTurn({
      projectRoot: "/project",
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain("monorepo");
  });
});

// ---------------------------------------------------------------------------
// formatMemoryFragments
// ---------------------------------------------------------------------------

describe("formatMemoryFragments", () => {
  it("returns null for empty fragments", () => {
    expect(formatMemoryFragments([])).toBeNull();
  });

  it("joins fragments with double newline", () => {
    const fragments: MemoryFragment[] = [
      { source: "a", content: "Fact A" },
      { source: "b", content: "Fact B" },
    ];
    const result = formatMemoryFragments(fragments);
    expect(result).toBe("Fact A\n\nFact B");
  });
});

// ---------------------------------------------------------------------------
// onAfterTurn
// ---------------------------------------------------------------------------

describe("onAfterTurn", () => {
  it("calls coordinator onTurnComplete without error", async () => {
    await onSessionStart();
    await onAfterTurn({
      sessionId: "s1",
      turnIndex: 0,
      toolsUsed: ["bash", "grep"],
    });
  });
});

// ---------------------------------------------------------------------------
// onCompaction
// ---------------------------------------------------------------------------

describe("onCompaction", () => {
  it("calls coordinator onCompress without error", async () => {
    await onSessionStart();
    await onCompaction({
      sessionId: "s1",
      messageCount: 50,
      summary: "Discussed memory architecture",
    });
  });
});

// ---------------------------------------------------------------------------
// onSessionEnd
// ---------------------------------------------------------------------------

describe("onSessionEnd", () => {
  it("archives the session and shuts down providers", async () => {
    await onSessionStart();

    await onSessionEnd({
      sessionId: "s1",
      summary: "Implemented memory system",
      tags: ["memory", "implementation"],
      toolsUsed: ["bash", "edit_file"],
    });

    const results = searchArchive("memory");
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe("s1");
    expect(results[0]!.tags).toEqual(["memory", "implementation"]);

    const coordinator = getMemoryCoordinator();
    expect(coordinator.providerCount).toBe(0);
  });

  it("archives with defaults for missing optional fields", async () => {
    await onSessionStart();

    await onSessionEnd({
      sessionId: "s2",
      summary: "Quick session",
    });

    const results = searchArchive("Quick");
    expect(results).toHaveLength(1);
    expect(results[0]!.tags).toEqual([]);
    expect(results[0]!.toolsUsed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("full lifecycle", () => {
  it("start → enrich → turn → end", async () => {
    // Add some memory first
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Uses Vitest",
    });

    // Start session
    await onSessionStart();

    // Before turn — get memory enrichment
    const fragments = await onBeforeTurn({ projectRoot: "/repo" });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain("Vitest");

    // After turn
    await onAfterTurn({
      sessionId: "lifecycle-test",
      turnIndex: 0,
      toolsUsed: ["bash"],
    });

    // End session
    await onSessionEnd({
      sessionId: "lifecycle-test",
      summary: "Full lifecycle test",
      toolsUsed: ["bash"],
    });

    // Verify archive
    const archived = searchArchive("lifecycle");
    expect(archived).toHaveLength(1);
  });
});
