import { describe, it, expect, afterEach } from "vitest";
import { memorySearchTool } from "./memory_search.js";
import {
  archiveSession,
  resetArchiveStore,
} from "../../memory/archive.js";
import type { ToolExecutionContext } from "../types.js";

afterEach(() => {
  resetArchiveStore();
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
