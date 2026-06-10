import { describe, it, expect } from "vitest";
import { RecoveryRegistry, DEFAULT_RECOVERY_STRATEGY } from "./registry.js";
import type { ConflictRecoveryStrategy, ConflictContext } from "./types.js";
import type { TeamSpec } from "../team-spec.js";

const ctx: ConflictContext = {
  conflictId: "c1",
  sourceAgentId: "a1",
  streamId: "s1",
  paths: ["src/a.ts"],
  operation: "merge",
  recoveryDepth: 0,
};

function spec(overrides: Partial<TeamSpec> = {}): TeamSpec {
  return {
    name: "t",
    topology: "peer-team",
    members: [{ role: "worker", prompt: "do" }],
    coordination: { completion: { kind: "all" } },
    ...overrides,
  };
}

const noop = (name: string): ConflictRecoveryStrategy => ({
  name,
  mode: "sync",
  async recover() {
    return { kind: "deferred", reason: `${name} ran` };
  },
});

describe("RecoveryRegistry.select", () => {
  it("falls back to defer when nothing is configured", () => {
    const r = new RecoveryRegistry();
    expect(r.select("worker", spec())).toBe(DEFAULT_RECOVERY_STRATEGY);
    expect(DEFAULT_RECOVERY_STRATEGY).toBe("defer");
  });

  it("uses the team default when set", () => {
    const r = new RecoveryRegistry();
    const s = spec({
      coordination: { completion: { kind: "all" }, conflictRecovery: { defaultStrategy: "escalate" } },
    });
    expect(r.select("worker", s)).toBe("escalate");
  });

  it("a member's onConflict overrides the team default", () => {
    const r = new RecoveryRegistry();
    const s = spec({
      members: [{ role: "coder", prompt: "do", onConflict: "spawn-resolver" }],
      coordination: { completion: { kind: "all" }, conflictRecovery: { defaultStrategy: "escalate" } },
    });
    expect(r.select("coder", s)).toBe("spawn-resolver");
  });

  it("falls back to team default for a role with no onConflict", () => {
    const r = new RecoveryRegistry();
    const s = spec({
      members: [
        { role: "coder", prompt: "do", onConflict: "spawn-resolver" },
        { role: "reviewer", prompt: "review" },
      ],
      coordination: { completion: { kind: "all" }, conflictRecovery: { defaultStrategy: "escalate" } },
    });
    expect(r.select("reviewer", s)).toBe("escalate");
  });
});

describe("RecoveryRegistry.recover", () => {
  it("dispatches to the registered strategy", async () => {
    const r = new RecoveryRegistry();
    r.register(noop("defer"));
    const res = await r.recover("defer", ctx);
    expect(res).toEqual({ kind: "deferred", reason: "defer ran" });
  });

  it("throws when the strategy is not registered", async () => {
    const r = new RecoveryRegistry();
    await expect(r.recover("escalate", ctx)).rejects.toThrow(/no strategy registered/);
  });

  it("get/has/list reflect registrations", () => {
    const r = new RecoveryRegistry();
    const s = noop("escalate");
    r.register(s);
    expect(r.get("escalate")).toBe(s);
    expect(r.has("escalate")).toBe(true);
    expect([...r.list()]).toEqual(["escalate"]);
  });
});
