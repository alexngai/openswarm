import { describe, it, expect, afterEach } from "vitest";
import type { AgentId } from "../../src/core/types.js";
import {
  agentScopeKey,
  publishSharedMemory,
  getSharedMemory,
  resetSharedMemory,
  formatSharedMemory,
} from "./agent-scope.js";

afterEach(() => {
  resetSharedMemory();
});

// ---------------------------------------------------------------------------
// Agent scope keys
// ---------------------------------------------------------------------------

describe("agentScopeKey", () => {
  it("builds agent-scoped project key", () => {
    const key = agentScopeKey("project", "/repo", "worker-1" as AgentId);
    expect(key).toBe("project:/repo:agent:worker-1");
  });

  it("builds agent-scoped user key", () => {
    const key = agentScopeKey("user", "alice", "agent-a" as AgentId);
    expect(key).toBe("user:alice:agent:agent-a");
  });
});

// ---------------------------------------------------------------------------
// Shared memory bus
// ---------------------------------------------------------------------------

describe("shared memory bus", () => {
  it("publishes and retrieves shared entries", () => {
    publishSharedMemory({
      publishedBy: "worker-1" as AgentId,
      content: "Database schema changed",
      tags: ["schema-change", "backend"],
      timestamp: new Date().toISOString(),
    });

    const entries = getSharedMemory();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe("Database schema changed");
    expect(entries[0]!.publishedBy).toBe("worker-1");
  });

  it("filters by tags", () => {
    publishSharedMemory({
      publishedBy: "worker-1" as AgentId,
      content: "Backend discovery",
      tags: ["backend"],
      timestamp: new Date().toISOString(),
    });
    publishSharedMemory({
      publishedBy: "worker-2" as AgentId,
      content: "Frontend discovery",
      tags: ["frontend"],
      timestamp: new Date().toISOString(),
    });

    const backendOnly = getSharedMemory({ tags: ["backend"] });
    expect(backendOnly).toHaveLength(1);
    expect(backendOnly[0]!.content).toContain("Backend");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      publishSharedMemory({
        publishedBy: "agent" as AgentId,
        content: `Entry ${i}`,
        tags: ["test"],
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      });
    }

    expect(getSharedMemory({ limit: 3 })).toHaveLength(3);
  });

  it("returns entries in reverse chronological order", () => {
    publishSharedMemory({
      publishedBy: "a" as AgentId,
      content: "First",
      tags: [],
      timestamp: "2026-06-01T00:00:00Z",
    });
    publishSharedMemory({
      publishedBy: "b" as AgentId,
      content: "Second",
      tags: [],
      timestamp: "2026-06-02T00:00:00Z",
    });

    const entries = getSharedMemory();
    expect(entries[0]!.content).toBe("Second");
    expect(entries[1]!.content).toBe("First");
  });

  it("returns empty when no entries", () => {
    expect(getSharedMemory()).toEqual([]);
  });

  it("evicts oldest entries when exceeding capacity", () => {
    for (let i = 0; i < 510; i++) {
      publishSharedMemory({
        publishedBy: "agent" as AgentId,
        content: `Entry ${i}`,
        tags: [],
        timestamp: new Date(Date.now() + i * 100).toISOString(),
      });
    }

    const entries = getSharedMemory();
    expect(entries.length).toBeLessThanOrEqual(500);
    expect(entries[entries.length - 1]!.content).not.toBe("Entry 0");
  });

  it("tag filtering is case-insensitive", () => {
    publishSharedMemory({
      publishedBy: "a" as AgentId,
      content: "Test",
      tags: ["Backend"],
      timestamp: new Date().toISOString(),
    });

    expect(getSharedMemory({ tags: ["backend"] })).toHaveLength(1);
    expect(getSharedMemory({ tags: ["BACKEND"] })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe("formatSharedMemory", () => {
  it("returns null for empty entries", () => {
    expect(formatSharedMemory([])).toBeNull();
  });

  it("formats entries with agent attribution", () => {
    const result = formatSharedMemory([
      {
        publishedBy: "worker-1" as AgentId,
        content: "Schema changed",
        tags: ["backend"],
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(result).toContain("[worker-1] Schema changed");
    expect(result).toContain("(backend)");
  });

  it("omits tags when empty", () => {
    const result = formatSharedMemory([
      {
        publishedBy: "agent" as AgentId,
        content: "Simple fact",
        tags: [],
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(result).toBe("[agent] Simple fact");
  });
});
