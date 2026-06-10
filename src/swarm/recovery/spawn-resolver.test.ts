import { describe, it, expect, vi } from "vitest";
import {
  spawnResolverStrategy,
  DEFAULT_MAX_RECOVERY_DEPTH,
} from "./spawn-resolver.js";
import { createDefaultRecoveryRegistry } from "./index.js";
import { BUILTIN_ROLES } from "../roles.js";
import type { ConflictContext, ConflictResolution } from "./types.js";

const baseCtx = (over: Partial<ConflictContext> = {}): ConflictContext => ({
  conflictId: "c1",
  sourceAgentId: "a1",
  streamId: "s1",
  paths: ["x.ts"],
  operation: "merge",
  recoveryDepth: 0,
  ...over,
});

const resolved: ConflictResolution = { kind: "resolved", resolutionCommit: "abc" };

describe("spawnResolverStrategy", () => {
  it("delegates to the injected spawnResolver", async () => {
    const spawnResolver = vi.fn(async () => resolved);
    const r = await spawnResolverStrategy.recover(baseCtx({ spawnResolver }));
    expect(spawnResolver).toHaveBeenCalledOnce();
    expect(r).toEqual(resolved);
  });

  it("escalates when no spawner is injected", async () => {
    expect(await spawnResolverStrategy.recover(baseCtx())).toEqual({
      kind: "escalated",
      escalatedTo: "human",
    });
  });

  it("escalates without spawning when recoveryDepth hits the default bound", async () => {
    const spawnResolver = vi.fn(async () => resolved);
    const r = await spawnResolverStrategy.recover(
      baseCtx({ recoveryDepth: DEFAULT_MAX_RECOVERY_DEPTH, spawnResolver }),
    );
    expect(spawnResolver).not.toHaveBeenCalled();
    expect(r.kind).toBe("escalated");
  });

  it("honors a custom maxRecoveryDepth from strategyConfig", async () => {
    const under = vi.fn(async () => resolved);
    await spawnResolverStrategy.recover(
      baseCtx({ recoveryDepth: 3, strategyConfig: { maxRecoveryDepth: 5 }, spawnResolver: under }),
    );
    expect(under).toHaveBeenCalledOnce();

    const over = vi.fn(async () => resolved);
    const r = await spawnResolverStrategy.recover(
      baseCtx({ recoveryDepth: 5, strategyConfig: { maxRecoveryDepth: 5 }, spawnResolver: over }),
    );
    expect(over).not.toHaveBeenCalled();
    expect(r.kind).toBe("escalated");
  });

  it("is registered in the default recovery registry", () => {
    expect(createDefaultRecoveryRegistry().has("spawn-resolver")).toBe(true);
  });
});

describe("resolver built-in role", () => {
  it("exists and grants commit_changes + resolve_conflict", () => {
    const resolver = BUILTIN_ROLES.find((r) => r.name === "resolver");
    expect(resolver).toBeDefined();
    expect(resolver?.allowedTools).toContain("commit_changes");
    expect(resolver?.allowedTools).toContain("resolve_conflict");
  });
});
