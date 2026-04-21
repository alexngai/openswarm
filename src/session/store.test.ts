/**
 * Tests for SessionStore.
 *
 * Mocks @anthropic-ai/claude-agent-sdk so no subprocess is spawned and no
 * filesystem access occurs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock SDK — vi.hoisted() ensures variables are available inside vi.mock factory.
// ---------------------------------------------------------------------------

const { mockListSessions, mockDeleteSession } = vi.hoisted(() => ({
  mockListSessions: vi.fn(),
  mockDeleteSession: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  listSessions: mockListSessions,
  deleteSession: mockDeleteSession,
}));

// ---------------------------------------------------------------------------
// Import under test (after mock is established).
// ---------------------------------------------------------------------------

import { SessionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_A = {
  sessionId: "session-aaa",
  summary: "First session",
  lastModified: 1_700_000_000_000,
  customTitle: "My first session",
};

const SESSION_B = {
  sessionId: "session-bbb",
  summary: "Second session",
  lastModified: 1_700_000_001_000,
};

// ---------------------------------------------------------------------------
// resolveLatest
// ---------------------------------------------------------------------------

describe("resolveLatest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the most-recent session id when SDK returns 1+ sessions", async () => {
    mockListSessions.mockResolvedValueOnce([SESSION_A]);
    const store = new SessionStore();
    const result = await store.resolveLatest("/some/project");
    expect(result).toBe("session-aaa");
    expect(mockListSessions).toHaveBeenCalledWith({
      dir: "/some/project",
      limit: 1,
      offset: 0,
    });
  });

  it("returns undefined when SDK returns an empty array", async () => {
    mockListSessions.mockResolvedValueOnce([]);
    const store = new SessionStore();
    const result = await store.resolveLatest("/empty/project");
    expect(result).toBeUndefined();
  });

  it("returns undefined when SDK throws (e.g. ENOENT for new project dir)", async () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    mockListSessions.mockRejectedValueOnce(err);
    const store = new SessionStore();
    const result = await store.resolveLatest("/brand/new/project");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

describe("buildSnapshot", () => {
  it("returns a SessionSnapshot with engineId='claude-agent-sdk' and sessionId in data", () => {
    const store = new SessionStore();
    const snapshot = store.buildSnapshot("session-xyz");
    expect(snapshot).toEqual({
      engineId: "claude-agent-sdk",
      data: { sessionId: "session-xyz" },
    });
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("maps SDK SDKSessionInfo to our SessionInfo shape", async () => {
    mockListSessions.mockResolvedValueOnce([SESSION_A, SESSION_B]);
    const store = new SessionStore();
    const result = await store.list("/some/project");

    expect(result).toHaveLength(2);
    // SESSION_A has customTitle — should use it over summary
    expect(result[0]).toEqual({
      id: "session-aaa",
      createdAt: 1_700_000_000_000,
      title: "My first session",
    });
    // SESSION_B has no customTitle — should fall back to summary
    expect(result[1]).toEqual({
      id: "session-bbb",
      createdAt: 1_700_000_001_000,
      title: "Second session",
    });
  });

  it("passes limit and offset through to SDK", async () => {
    mockListSessions.mockResolvedValueOnce([SESSION_B]);
    const store = new SessionStore();
    await store.list("/some/project", { limit: 10, offset: 5 });
    expect(mockListSessions).toHaveBeenCalledWith({
      dir: "/some/project",
      limit: 10,
      offset: 5,
    });
  });

  it("passes undefined limit/offset when opts is omitted", async () => {
    mockListSessions.mockResolvedValueOnce([]);
    const store = new SessionStore();
    await store.list("/some/project");
    expect(mockListSessions).toHaveBeenCalledWith({
      dir: "/some/project",
      limit: undefined,
      offset: undefined,
    });
  });
});
