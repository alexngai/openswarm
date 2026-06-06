import { describe, it, expect, afterEach } from "vitest";
import { FileMemoryProvider } from "./file-provider.js";
import {
  executeCuratedAction,
  resetCuratedMemoryStore,
  resetCuratedMemoryLimits,
} from "../curated.js";

afterEach(() => {
  resetCuratedMemoryStore();
  resetCuratedMemoryLimits();
});

describe("FileMemoryProvider", () => {
  it("reports correct name and capabilities", () => {
    const provider = new FileMemoryProvider();
    expect(provider.name).toBe("file");
    expect(provider.capabilities.enrichment).toBe(true);
    expect(provider.capabilities.persistence).toBe(true);
    expect(provider.capabilities.search).toBe(false);
    expect(provider.capabilities.graph).toBe(false);
  });

  it("isAvailable always returns true", async () => {
    const provider = new FileMemoryProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it("initialize and shutdown are no-ops", async () => {
    const provider = new FileMemoryProvider();
    await provider.initialize({});
    await provider.shutdown();
  });

  it("enrichTurn returns empty when no memory exists", async () => {
    const provider = new FileMemoryProvider();
    await provider.initialize({});

    const fragments = await provider.enrichTurn({
      userId: "alice",
      projectRoot: "/project",
    });
    expect(fragments).toEqual([]);
  });

  it("enrichTurn returns user memory", async () => {
    executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "alice",
      entry: "Prefers TypeScript",
    });

    const provider = new FileMemoryProvider();
    await provider.initialize({});

    const fragments = await provider.enrichTurn({
      userId: "alice",
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.source).toBe("file:user");
    expect(fragments[0]!.content).toContain("Prefers TypeScript");
  });

  it("enrichTurn returns project memory", async () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/my-repo",
      entry: "Uses Vitest for testing",
    });

    const provider = new FileMemoryProvider();
    await provider.initialize({});

    const fragments = await provider.enrichTurn({
      projectRoot: "/my-repo",
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.source).toBe("file:project");
    expect(fragments[0]!.content).toContain("Vitest");
  });

  it("enrichTurn returns both scopes", async () => {
    executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "bob",
      entry: "User fact",
    });
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Project fact",
    });

    const provider = new FileMemoryProvider();
    await provider.initialize({});

    const fragments = await provider.enrichTurn({
      userId: "bob",
      projectRoot: "/repo",
    });
    expect(fragments).toHaveLength(2);
    const sources = fragments.map((f) => f.source);
    expect(sources).toContain("file:user");
    expect(sources).toContain("file:project");
  });

  it("enrichTurn skips scopes not provided", async () => {
    executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "alice",
      entry: "User fact",
    });

    const provider = new FileMemoryProvider();
    await provider.initialize({});

    const fragments = await provider.enrichTurn({
      projectRoot: "/some-repo",
    });
    expect(fragments).toHaveLength(0);
  });

  it("onMemoryWrite, onTurnComplete, onCompress are no-ops", async () => {
    const provider = new FileMemoryProvider();
    await provider.initialize({});

    await provider.onMemoryWrite({
      scope: "project",
      content: "test",
      timestamp: new Date().toISOString(),
    });
    await provider.onTurnComplete({
      sessionId: "s1",
      turnIndex: 0,
      toolsUsed: [],
    });
    await provider.onCompress({
      sessionId: "s1",
      messageCount: 10,
      summary: "test",
    });
  });
});
