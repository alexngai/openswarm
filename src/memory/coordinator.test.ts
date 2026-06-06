import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MemoryCoordinator,
  getMemoryCoordinator,
  resetMemoryCoordinator,
} from "./coordinator.js";
import type {
  MemoryProvider,
  MemoryFragment,
  TurnContext,
  MemoryEntry,
  CompletedTurn,
  CompressionSummary,
} from "./types.js";

afterEach(() => {
  resetMemoryCoordinator();
});

function makeProvider(
  name: string,
  overrides?: Partial<MemoryProvider>,
): MemoryProvider {
  return {
    name,
    capabilities: {
      enrichment: true,
      persistence: true,
      search: false,
      graph: false,
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(true),
    enrichTurn: vi.fn().mockResolvedValue([]),
    onMemoryWrite: vi.fn().mockResolvedValue(undefined),
    onTurnComplete: vi.fn().mockResolvedValue(undefined),
    onCompress: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("MemoryCoordinator registration", () => {
  it("registers a provider", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("test");
    await coord.register(p);
    expect(coord.providerNames).toEqual(["test"]);
    expect(coord.providerCount).toBe(1);
    expect(p.initialize).toHaveBeenCalledWith({});
  });

  it("rejects duplicate provider names", async () => {
    const coord = new MemoryCoordinator();
    await coord.register(makeProvider("dupe"));
    await expect(coord.register(makeProvider("dupe"))).rejects.toThrow("already registered");
  });

  it("unregisters a provider and calls shutdown", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("removable");
    await coord.register(p);
    await coord.unregister("removable");
    expect(coord.providerCount).toBe(0);
    expect(p.shutdown).toHaveBeenCalled();
  });

  it("unregister is a no-op for unknown names", async () => {
    const coord = new MemoryCoordinator();
    await coord.unregister("nonexistent");
    expect(coord.providerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enrichTurn
// ---------------------------------------------------------------------------

describe("MemoryCoordinator enrichTurn", () => {
  it("returns empty array with no providers", async () => {
    const coord = new MemoryCoordinator();
    const result = await coord.enrichTurn({ query: "test" });
    expect(result).toEqual([]);
  });

  it("merges fragments from multiple providers", async () => {
    const coord = new MemoryCoordinator();
    const p1 = makeProvider("p1", {
      enrichTurn: vi.fn().mockResolvedValue([
        { source: "p1", content: "fact A" },
      ]),
    });
    const p2 = makeProvider("p2", {
      enrichTurn: vi.fn().mockResolvedValue([
        { source: "p2", content: "fact B" },
      ]),
    });
    await coord.register(p1);
    await coord.register(p2);

    const result = await coord.enrichTurn({ query: "test" });
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.content)).toEqual(["fact A", "fact B"]);
  });

  it("deduplicates fragments by content", async () => {
    const coord = new MemoryCoordinator();
    const p1 = makeProvider("p1", {
      enrichTurn: vi.fn().mockResolvedValue([
        { source: "p1", content: "same fact" },
      ]),
    });
    const p2 = makeProvider("p2", {
      enrichTurn: vi.fn().mockResolvedValue([
        { source: "p2", content: "same fact" },
      ]),
    });
    await coord.register(p1);
    await coord.register(p2);

    const result = await coord.enrichTurn({ query: "test" });
    expect(result).toHaveLength(1);
  });

  it("skips providers without enrichment capability", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("no-enrich", {
      capabilities: { enrichment: false, persistence: true, search: false, graph: false },
      enrichTurn: vi.fn().mockResolvedValue([{ source: "x", content: "should not appear" }]),
    });
    await coord.register(p);

    const result = await coord.enrichTurn({ query: "test" });
    expect(result).toHaveLength(0);
    expect(p.enrichTurn).not.toHaveBeenCalled();
  });

  it("tolerates provider errors gracefully", async () => {
    const coord = new MemoryCoordinator();
    const failing = makeProvider("fail", {
      enrichTurn: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const working = makeProvider("ok", {
      enrichTurn: vi.fn().mockResolvedValue([{ source: "ok", content: "good" }]),
    });
    await coord.register(failing);
    await coord.register(working);

    const result = await coord.enrichTurn({ query: "test" });
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("good");
  });
});

// ---------------------------------------------------------------------------
// Fire-and-forget hooks
// ---------------------------------------------------------------------------

describe("MemoryCoordinator write/complete/compress hooks", () => {
  it("fans out onMemoryWrite to persistence-capable providers", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("writer");
    await coord.register(p);

    const entry: MemoryEntry = {
      scope: "project",
      content: "test",
      timestamp: new Date().toISOString(),
    };
    await coord.onMemoryWrite(entry);
    expect(p.onMemoryWrite).toHaveBeenCalledWith(entry);
  });

  it("skips onMemoryWrite for non-persistence providers", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("no-persist", {
      capabilities: { enrichment: true, persistence: false, search: false, graph: false },
    });
    await coord.register(p);
    await coord.onMemoryWrite({
      scope: "project",
      content: "test",
      timestamp: new Date().toISOString(),
    });
    expect(p.onMemoryWrite).not.toHaveBeenCalled();
  });

  it("fans out onTurnComplete to all providers", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("turner");
    await coord.register(p);

    const turn: CompletedTurn = {
      sessionId: "s1",
      turnIndex: 0,
      toolsUsed: ["bash"],
    };
    await coord.onTurnComplete(turn);
    expect(p.onTurnComplete).toHaveBeenCalledWith(turn);
  });

  it("fans out onCompress to all providers", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("compressor");
    await coord.register(p);

    const summary: CompressionSummary = {
      sessionId: "s1",
      messageCount: 50,
      summary: "Discussed memory design",
    };
    await coord.onCompress(summary);
    expect(p.onCompress).toHaveBeenCalledWith(summary);
  });

  it("tolerates errors in fire-and-forget hooks", async () => {
    const coord = new MemoryCoordinator();
    const p = makeProvider("fail-write", {
      onMemoryWrite: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    await coord.register(p);

    await expect(
      coord.onMemoryWrite({
        scope: "project",
        content: "test",
        timestamp: new Date().toISOString(),
      }),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("MemoryCoordinator shutdown", () => {
  it("shuts down all providers and clears list", async () => {
    const coord = new MemoryCoordinator();
    const p1 = makeProvider("p1");
    const p2 = makeProvider("p2");
    await coord.register(p1);
    await coord.register(p2);

    await coord.shutdown();
    expect(p1.shutdown).toHaveBeenCalled();
    expect(p2.shutdown).toHaveBeenCalled();
    expect(coord.providerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("coordinator singleton", () => {
  it("returns consistent instance", () => {
    const c1 = getMemoryCoordinator();
    const c2 = getMemoryCoordinator();
    expect(c1).toBe(c2);
  });

  it("resets cleanly", () => {
    const c1 = getMemoryCoordinator();
    resetMemoryCoordinator();
    const c2 = getMemoryCoordinator();
    expect(c1).not.toBe(c2);
  });
});
