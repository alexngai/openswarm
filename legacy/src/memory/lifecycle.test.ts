import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  onSessionStart,
  onBeforeTurn,
  onAfterTurn,
  onCompaction,
  onSessionEnd,
  formatMemoryFragments,
  budgetFragments,
  enrichTurnInputs,
  resetMemoryInjectionState,
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
  resetMemoryInjectionState();
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
// budgetFragments (docs/53 TE-1)
// ---------------------------------------------------------------------------

describe("budgetFragments", () => {
  it("keeps the most relevant fragments until the byte budget is exhausted", () => {
    const fragments: MemoryFragment[] = [
      { source: "low", content: "x".repeat(40), relevance: 0.2 },
      { source: "high", content: "y".repeat(40), relevance: 0.9 },
      { source: "mid", content: "z".repeat(40), relevance: 0.5 },
    ];
    const { kept, droppedCount, droppedBytes } = budgetFragments(fragments, 100);
    expect(kept.map((f) => f.source)).toEqual(["high", "mid"]);
    expect(droppedCount).toBe(1);
    expect(droppedBytes).toBe(40);
  });

  it("preserves provider order among equal relevance (stable)", () => {
    const fragments: MemoryFragment[] = [
      { source: "first", content: "a" },
      { source: "second", content: "b" },
    ];
    const { kept } = budgetFragments(fragments, 100);
    expect(kept.map((f) => f.source)).toEqual(["first", "second"]);
  });

  it("truncates rather than drops when the top fragment alone exceeds budget", () => {
    const fragments: MemoryFragment[] = [
      { source: "big", content: "m".repeat(500), relevance: 1 },
    ];
    const { kept, droppedCount } = budgetFragments(fragments, 100);
    expect(kept).toHaveLength(1);
    expect(Buffer.byteLength(kept[0]!.content, "utf8")).toBeLessThanOrEqual(100);
    expect(kept[0]!.content).toContain("[memory fragment truncated");
    expect(droppedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enrichTurnInputs (docs/53 TE-1/TE-2)
// ---------------------------------------------------------------------------

describe("enrichTurnInputs", () => {
  it("injects memory into the USER prompt, never the system prompt", async () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Uses Vitest",
    });
    const enriched = await enrichTurnInputs("You are an agent.", "Fix the bug.", {
      projectRoot: "/repo",
      sessionId: "s-place",
    });
    // System prompt is byte-stable (prompt-cache prefix stays intact).
    expect(enriched.systemPrompt).toBe("You are an agent.");
    expect(enriched.prompt).toContain("<memory-context>");
    expect(enriched.prompt).toContain("Uses Vitest");
    expect(enriched.prompt).toContain("</memory-context>");
    expect(enriched.prompt).toContain("# Task\nFix the bug.");
  });

  it("skips re-injection when the block is unchanged (still reports skills)", async () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Uses Vitest",
    });
    const ctx = { projectRoot: "/repo", sessionId: "s-dedup" };
    const first = await enrichTurnInputs("sys", "turn one", ctx);
    expect(first.prompt).toContain("<memory-context>");

    const second = await enrichTurnInputs("sys", "turn two", ctx);
    expect(second.prompt).toBe("turn two"); // unchanged block → no re-injection
  });

  it("re-injects with a replacement notice when memory changes", async () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Uses Vitest",
    });
    const ctx = { projectRoot: "/repo", sessionId: "s-change" };
    await enrichTurnInputs("sys", "turn one", ctx);

    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Dual lockfiles are deliberate",
    });
    const second = await enrichTurnInputs("sys", "turn two", ctx);
    expect(second.prompt).toContain("<memory-context>");
    expect(second.prompt).toContain("Dual lockfiles");
    expect(second.prompt).toContain("replaces all previously provided memory context");
  });

  it("tracks injection state per (session, agent) key", async () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Uses Vitest",
    });
    await enrichTurnInputs("sys", "p", { projectRoot: "/repo", sessionId: "s-A" });
    // A different session still gets the block.
    const other = await enrichTurnInputs("sys", "p", { projectRoot: "/repo", sessionId: "s-B" });
    expect(other.prompt).toContain("<memory-context>");
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
