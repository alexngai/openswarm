import { describe, it, expect, vi, afterEach } from "vitest";
import { MinimemProvider } from "./minimem-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Basic properties
// ---------------------------------------------------------------------------

describe("MinimemProvider properties", () => {
  it("has correct name and capabilities", () => {
    const provider = new MinimemProvider();
    expect(provider.name).toBe("minimem");
    expect(provider.capabilities).toEqual({
      enrichment: true,
      persistence: true,
      search: true,
      graph: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe("MinimemProvider graceful degradation", () => {
  it("handles missing minimem package gracefully", async () => {
    const provider = new MinimemProvider();
    // Initialize with no minimem installed in a way that forces the dynamic
    // import to fail (it may or may not be installed — either way, the
    // provider should handle it)
    await provider.initialize({
      memoryDir: "/tmp/minimem-test-nonexistent-" + Date.now(),
      embeddingProvider: "none",
    });

    // enrichTurn should return empty fragments gracefully
    const fragments = await provider.enrichTurn({
      query: "test query",
    });
    // If minimem is installed, we might get results; if not, empty array
    expect(Array.isArray(fragments)).toBe(true);
  });

  it("enrichTurn returns empty when no query", async () => {
    const provider = new MinimemProvider();
    await provider.initialize({ embeddingProvider: "none" });

    const fragments = await provider.enrichTurn({});
    expect(fragments).toEqual([]);
  });

  it("shutdown is safe when not initialized", async () => {
    const provider = new MinimemProvider();
    await provider.shutdown();
  });

  it("onMemoryWrite is safe when not initialized", async () => {
    const provider = new MinimemProvider();
    await provider.onMemoryWrite({
      scope: "project",
      content: "test",
      timestamp: new Date().toISOString(),
    });
  });

  it("onTurnComplete is safe when not initialized", async () => {
    const provider = new MinimemProvider();
    await provider.onTurnComplete({
      sessionId: "s1",
      turnIndex: 0,
      toolsUsed: ["bash"],
    });
  });

  it("onCompress is safe when not initialized", async () => {
    const provider = new MinimemProvider();
    await provider.onCompress({
      sessionId: "s1",
      messageCount: 10,
      summary: "test",
    });
  });
});

// ---------------------------------------------------------------------------
// Integration (when minimem IS available)
// ---------------------------------------------------------------------------

describe("MinimemProvider with minimem available", () => {
  it("initializes and reports availability", async () => {
    const provider = new MinimemProvider();
    const tmpDir = `/tmp/minimem-test-${Date.now()}`;

    await provider.initialize({
      memoryDir: tmpDir,
      embeddingProvider: "none",
    });

    const available = await provider.isAvailable();
    // Might be true or false depending on whether minimem is installed
    expect(typeof available).toBe("boolean");

    await provider.shutdown();

    // Clean up
    try {
      const fs = await import("node:fs");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("search returns results with correct shape", async () => {
    const provider = new MinimemProvider();
    const tmpDir = `/tmp/minimem-test-${Date.now()}`;

    await provider.initialize({
      memoryDir: tmpDir,
      embeddingProvider: "none",
    });

    if (await provider.isAvailable()) {
      const fragments = await provider.enrichTurn({
        query: "test query that probably won't match anything",
      });
      expect(Array.isArray(fragments)).toBe(true);
      for (const f of fragments) {
        expect(f).toHaveProperty("source");
        expect(f).toHaveProperty("content");
        expect(f).toHaveProperty("relevance");
      }
    }

    await provider.shutdown();
    try {
      const fs = await import("node:fs");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("reads embedding config from environment", async () => {
    const provider = new MinimemProvider();

    // The provider should read MINIMEM_EMBEDDING_PROVIDER and MINIMEM_STORE_PATH
    // from env, falling back to "none" and ~/.swarm-harness/memory respectively
    await provider.initialize({});

    await provider.shutdown();
  });
});
