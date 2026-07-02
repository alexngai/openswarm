import { describe, it, expect, afterEach } from "vitest";
import {
  Goal,
  GoalRegistry,
  GoalTransitionError,
  canTransition,
  getGoalRegistry,
  resetGoalRegistry,
  type GoalStatus,
} from "./goal.js";

afterEach(() => {
  resetGoalRegistry();
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("canTransition", () => {
  it("allows valid transitions from active", () => {
    expect(canTransition("active", "paused")).toBe(true);
    expect(canTransition("active", "blocked")).toBe(true);
    expect(canTransition("active", "usage_limited")).toBe(true);
    expect(canTransition("active", "budget_limited")).toBe(true);
    expect(canTransition("active", "complete")).toBe(true);
  });

  it("allows resume from suspended states", () => {
    expect(canTransition("paused", "active")).toBe(true);
    expect(canTransition("blocked", "active")).toBe(true);
    expect(canTransition("usage_limited", "active")).toBe(true);
    expect(canTransition("budget_limited", "active")).toBe(true);
  });

  it("allows completion from any suspended state", () => {
    expect(canTransition("paused", "complete")).toBe(true);
    expect(canTransition("blocked", "complete")).toBe(true);
    expect(canTransition("usage_limited", "complete")).toBe(true);
    expect(canTransition("budget_limited", "complete")).toBe(true);
  });

  it("disallows transitions from complete", () => {
    expect(canTransition("complete", "active")).toBe(false);
    expect(canTransition("complete", "paused")).toBe(false);
  });

  it("disallows invalid transitions", () => {
    expect(canTransition("paused", "blocked")).toBe(false);
    expect(canTransition("blocked", "usage_limited")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Goal lifecycle
// ---------------------------------------------------------------------------

describe("Goal", () => {
  it("initializes with active status", () => {
    const goal = new Goal({ description: "test goal" });
    expect(goal.status).toBe("active");
    expect(goal.isActive).toBe(true);
    expect(goal.isTerminal).toBe(false);
    expect(goal.isSuspended).toBe(false);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.turnCount).toBe(0);
  });

  it("generates unique id", () => {
    const g1 = new Goal({ description: "a" });
    const g2 = new Goal({ description: "b" });
    expect(g1.id).not.toBe(g2.id);
  });

  it("transitions through valid states", () => {
    const goal = new Goal({ description: "test" });
    goal.pause();
    expect(goal.status).toBe("paused");
    expect(goal.isSuspended).toBe(true);

    goal.resume();
    expect(goal.status).toBe("active");

    goal.block();
    expect(goal.status).toBe("blocked");

    goal.resume();
    goal.complete();
    expect(goal.status).toBe("complete");
    expect(goal.isTerminal).toBe(true);
  });

  it("throws on invalid transitions", () => {
    const goal = new Goal({ description: "test" });
    goal.complete();
    expect(() => goal.resume()).toThrow(GoalTransitionError);
  });

  it("records usage and increments turn count", () => {
    const goal = new Goal({ description: "test" });
    const result = goal.recordUsage({
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(goal.tokensUsed).toBe(1500);
    expect(goal.turnCount).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  it("detects token budget exhaustion", () => {
    const goal = new Goal({
      description: "test",
      tokenBudget: 2000,
    });

    expect(goal.tokenBudgetRemaining).toBe(2000);

    goal.recordUsage({ inputTokens: 1000, outputTokens: 500 });
    expect(goal.tokenBudgetRemaining).toBe(500);

    const result = goal.recordUsage({
      inputTokens: 500,
      outputTokens: 200,
    });
    expect(result.exceeded).toBe(true);
    expect(result.limitType).toBe("usage");
    expect(goal.tokenBudgetRemaining).toBe(0);
  });

  it("detects cost budget exhaustion", () => {
    const goal = new Goal({
      description: "test",
      costBudgetUsd: 0.01,
    });

    goal.recordCost(0.005);
    expect(goal.checkBudget().exceeded).toBe(false);

    goal.recordCost(0.006);
    expect(goal.checkBudget().exceeded).toBe(true);
    expect(goal.checkBudget().limitType).toBe("budget");
  });

  it("enforces budget by transitioning state", () => {
    const goal = new Goal({
      description: "test",
      tokenBudget: 1000,
    });

    goal.recordUsage({ inputTokens: 800, outputTokens: 300 });
    goal.enforcebudget();

    expect(goal.status).toBe("usage_limited");
  });

  it("returns null budget remaining when no budget", () => {
    const goal = new Goal({ description: "test" });
    expect(goal.tokenBudgetRemaining).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Checkpointing
// ---------------------------------------------------------------------------

describe("Goal checkpointing", () => {
  it("creates checkpoints", () => {
    const goal = new Goal({ description: "test" });
    goal.recordUsage({ inputTokens: 100, outputTokens: 50 });

    const cp = goal.checkpoint("snapshot-data");
    expect(cp.turnCount).toBe(1);
    expect(cp.tokensUsed).toBe(150);
    expect(cp.snapshotData).toBe("snapshot-data");
    expect(goal.checkpoints).toHaveLength(1);
  });

  it("accumulates multiple checkpoints", () => {
    const goal = new Goal({ description: "test" });
    goal.checkpoint();
    goal.recordUsage({ inputTokens: 100, outputTokens: 50 });
    goal.checkpoint("second");

    expect(goal.checkpoints).toHaveLength(2);
    expect(goal.checkpoints[1]!.snapshotData).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("Goal serialization", () => {
  it("round-trips through toRecord/fromRecord", () => {
    const goal = new Goal({
      description: "test goal",
      tokenBudget: 5000,
      parentId: "parent-1",
    });
    goal.recordUsage({ inputTokens: 1000, outputTokens: 500 });
    goal.checkpoint("snap");

    const record = goal.toRecord("session-1");
    const restored = Goal.fromRecord(record);

    expect(restored.id).toBe(goal.id);
    expect(restored.description).toBe("test goal");
    expect(restored.parentId).toBe("parent-1");
    expect(restored.status).toBe("active");
    expect(restored.tokensUsed).toBe(1500);
    expect(restored.turnCount).toBe(1);
    expect(restored.tokenBudget).toBe(5000);
    expect(restored.checkpoints).toHaveLength(1);
  });

  it("handles goals without budget or checkpoints", () => {
    const goal = new Goal({ description: "minimal" });
    const record = goal.toRecord("s1");
    const restored = Goal.fromRecord(record);

    expect(restored.tokenBudget).toBeNull();
    expect(restored.checkpoints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GoalRegistry
// ---------------------------------------------------------------------------

describe("GoalRegistry", () => {
  it("creates and retrieves goals", () => {
    const reg = new GoalRegistry();
    const goal = reg.create({ description: "test" });
    expect(reg.get(goal.id)).toBe(goal);
    expect(reg.size).toBe(1);
  });

  it("lists active goals", () => {
    const reg = new GoalRegistry();
    const g1 = reg.create({ description: "active goal" });
    const g2 = reg.create({ description: "completed goal" });
    g2.complete();

    const active = reg.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(g1.id);
  });

  it("lists by status", () => {
    const reg = new GoalRegistry();
    reg.create({ description: "a" });
    const g2 = reg.create({ description: "b" });
    g2.complete();

    expect(reg.listByStatus("active")).toHaveLength(1);
    expect(reg.listByStatus("complete")).toHaveLength(1);
    expect(reg.listByStatus("paused")).toHaveLength(0);
  });

  it("removes goals", () => {
    const reg = new GoalRegistry();
    const goal = reg.create({ description: "test" });
    expect(reg.remove(goal.id)).toBe(true);
    expect(reg.get(goal.id)).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it("clears all goals", () => {
    const reg = new GoalRegistry();
    reg.create({ description: "a" });
    reg.create({ description: "b" });
    reg.clear();
    expect(reg.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("singleton management", () => {
  it("returns consistent instance", () => {
    const r1 = getGoalRegistry();
    const r2 = getGoalRegistry();
    expect(r1).toBe(r2);
  });

  it("resets singleton", () => {
    const r1 = getGoalRegistry();
    resetGoalRegistry();
    const r2 = getGoalRegistry();
    expect(r1).not.toBe(r2);
  });
});
