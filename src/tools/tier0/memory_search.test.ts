import { describe, it, expect, afterEach, vi } from "vitest";
import { memorySearchTool } from "./memory_search.js";
import {
  archiveSession,
  resetArchiveStore,
} from "../../memory/archive.js";
import {
  getMemoryCoordinator,
  resetMemoryCoordinator,
} from "../../memory/coordinator.js";
import type { MemoryProvider } from "../../memory/types.js";
import type { ToolExecutionContext } from "../types.js";

afterEach(async () => {
  resetArchiveStore();
  await resetMemoryCoordinator();
});

function ctx(): ToolExecutionContext {
  return { cwd: "/tmp" };
}

describe("memorySearchTool", () => {
  it("has correct spec", () => {
    expect(memorySearchTool.spec.name).toBe("memory_search");
    expect(memorySearchTool.spec.tier).toBe(0);
    expect(memorySearchTool.spec.requiredPermission).toBe("none");
  });

  it("returns no-results message when archive is empty", async () => {
    const result = await memorySearchTool.execute(
      { query: "anything" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("No archived sessions found");
    }
  });

  it("finds matching sessions", async () => {
    archiveSession({
      sessionId: "s1",
      summary: "Implemented memory system with curated entries",
      tags: ["memory", "implementation"],
      toolsUsed: ["bash", "edit_file"],
    });
    archiveSession({
      sessionId: "s2",
      summary: "Fixed bug in web search backend",
      tags: ["bugfix", "web"],
    });

    const result = await memorySearchTool.execute(
      { query: "memory" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("1 session");
      expect(result.output).toContain("s1");
      expect(result.output).toContain("memory system");
      expect(result.output).toContain("Tags: memory, implementation");
      expect(result.output).toContain("Tools: bash, edit_file");
    }
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      archiveSession({
        sessionId: `s${i}`,
        summary: `Session ${i} about testing`,
      });
    }

    const result = await memorySearchTool.execute(
      { query: "testing", limit: 2 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("2 sessions");
    }
  });

  it("returns error for invalid input", async () => {
    const result = await memorySearchTool.execute({}, ctx());
    expect(result.status).toBe("error");
  });

  it("returns error for empty query", async () => {
    const result = await memorySearchTool.execute({ query: "" }, ctx());
    expect(result.status).toBe("error");
  });

  it("includes date in output", async () => {
    archiveSession({
      sessionId: "s1",
      summary: "A session",
    });

    const result = await memorySearchTool.execute(
      { query: "session" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Date:");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3 B2 — coordinator-backed search, grouped by provider (Q5)
// ---------------------------------------------------------------------------

describe("memorySearchTool — coordinator providers (Phase 3 B2)", () => {
  function searchProvider(
    name: string,
    results: Array<{ source: string; content: string }>,
  ): MemoryProvider {
    return {
      name,
      capabilities: { enrichment: false, persistence: false, search: true, graph: false },
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      isAvailable: vi.fn().mockResolvedValue(true),
      enrichTurn: vi.fn().mockResolvedValue([]),
      onMemoryWrite: vi.fn().mockResolvedValue(undefined),
      onTurnComplete: vi.fn().mockResolvedValue(undefined),
      onCompress: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue(results),
    };
  }

  it("groups results by provider with source labels", async () => {
    const coord = getMemoryCoordinator();
    await coord.register(
      searchProvider("minimem", [
        { source: "minimem:notes/today.md", content: "vector hit" },
      ]),
    );
    await coord.register(
      searchProvider("file", [
        { source: "file:archive:s9", content: "archive hit" },
      ]),
    );

    const result = await memorySearchTool.execute({ query: "hit" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("grouped by provider");
      expect(result.output).toContain("## minimem");
      expect(result.output).toContain("[minimem:notes/today.md]");
      expect(result.output).toContain("vector hit");
      expect(result.output).toContain("## file");
      expect(result.output).toContain("archive hit");
    }
  });

  it("reports no memories when providers exist but nothing matches", async () => {
    await getMemoryCoordinator().register(searchProvider("minimem", []));
    const result = await memorySearchTool.execute({ query: "nada" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("No memories found");
    }
  });
});
