/**
 * Goals engine — modeled on Codex core/src/goals.rs.
 *
 * Provides a goal state machine with 6 states, token budget tracking,
 * checkpoint management, and automatic state transitions on budget
 * exhaustion. Goals wrap around engine runs and survive across
 * continuations.
 */

import * as crypto from "node:crypto";
import type { Usage } from "./types.js";

// ---------------------------------------------------------------------------
// Goal state machine
// ---------------------------------------------------------------------------

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

const VALID_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ["paused", "blocked", "usage_limited", "budget_limited", "complete"],
  paused: ["active", "complete"],
  blocked: ["active", "complete"],
  usage_limited: ["active", "complete"],
  budget_limited: ["active", "complete"],
  complete: [],
};

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export interface GoalCheckpoint {
  readonly turnCount: number;
  readonly tokensUsed: number;
  readonly createdAt: string;
  readonly snapshotData?: string;
}

export interface GoalOptions {
  readonly description: string;
  readonly tokenBudget?: number;
  readonly costBudgetUsd?: number;
  readonly parentId?: string;
}

export class Goal {
  readonly id: string;
  readonly description: string;
  readonly parentId?: string;
  readonly createdAt: string;

  private _status: GoalStatus = "active";
  private _tokenBudget: number | null;
  private _costBudgetUsd: number | null;
  private _tokensUsed = 0;
  private _costUsed = 0;
  private _turnCount = 0;
  private _updatedAt: string;
  private _checkpoints: GoalCheckpoint[] = [];

  constructor(opts: GoalOptions) {
    this.id = crypto.randomUUID();
    this.description = opts.description;
    this.parentId = opts.parentId;
    this._tokenBudget = opts.tokenBudget ?? null;
    this._costBudgetUsd = opts.costBudgetUsd ?? null;
    const now = new Date().toISOString();
    this.createdAt = now;
    this._updatedAt = now;
  }

  get status(): GoalStatus {
    return this._status;
  }

  get tokenBudget(): number | null {
    return this._tokenBudget;
  }

  get costBudgetUsd(): number | null {
    return this._costBudgetUsd;
  }

  get tokensUsed(): number {
    return this._tokensUsed;
  }

  get costUsed(): number {
    return this._costUsed;
  }

  get turnCount(): number {
    return this._turnCount;
  }

  get updatedAt(): string {
    return this._updatedAt;
  }

  get checkpoints(): readonly GoalCheckpoint[] {
    return this._checkpoints;
  }

  get isTerminal(): boolean {
    return this._status === "complete";
  }

  get isActive(): boolean {
    return this._status === "active";
  }

  get isSuspended(): boolean {
    return (
      this._status === "paused" ||
      this._status === "blocked" ||
      this._status === "usage_limited" ||
      this._status === "budget_limited"
    );
  }

  get tokenBudgetRemaining(): number | null {
    if (this._tokenBudget === null) return null;
    return Math.max(0, this._tokenBudget - this._tokensUsed);
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  transition(to: GoalStatus): void {
    if (!canTransition(this._status, to)) {
      throw new GoalTransitionError(this._status, to);
    }
    this._status = to;
    this._updatedAt = new Date().toISOString();
  }

  complete(): void {
    this.transition("complete");
  }

  pause(): void {
    this.transition("paused");
  }

  resume(): void {
    this.transition("active");
  }

  block(reason?: string): void {
    this.transition("blocked");
    if (reason) {
      this.checkpoint(reason);
    }
  }

  // -------------------------------------------------------------------------
  // Usage tracking
  // -------------------------------------------------------------------------

  recordUsage(usage: Usage): BudgetCheckResult {
    const tokens = usage.inputTokens + usage.outputTokens;
    this._tokensUsed += tokens;
    this._turnCount++;
    this._updatedAt = new Date().toISOString();

    return this.checkBudget();
  }

  recordCost(costUsd: number): void {
    this._costUsed += costUsd;
    this._updatedAt = new Date().toISOString();
  }

  checkBudget(): BudgetCheckResult {
    if (
      this._tokenBudget !== null &&
      this._tokensUsed >= this._tokenBudget
    ) {
      return {
        exceeded: true,
        reason: `token budget exhausted: ${this._tokensUsed} / ${this._tokenBudget}`,
        limitType: "usage",
      };
    }

    if (
      this._costBudgetUsd !== null &&
      this._costUsed >= this._costBudgetUsd
    ) {
      return {
        exceeded: true,
        reason: `cost budget exhausted: $${this._costUsed.toFixed(4)} / $${this._costBudgetUsd}`,
        limitType: "budget",
      };
    }

    return { exceeded: false };
  }

  enforcebudget(): void {
    const result = this.checkBudget();
    if (!result.exceeded) return;

    if (result.limitType === "usage") {
      this.transition("usage_limited");
    } else {
      this.transition("budget_limited");
    }
  }

  // -------------------------------------------------------------------------
  // Checkpointing
  // -------------------------------------------------------------------------

  checkpoint(snapshotData?: string): GoalCheckpoint {
    const cp: GoalCheckpoint = {
      turnCount: this._turnCount,
      tokensUsed: this._tokensUsed,
      createdAt: new Date().toISOString(),
      snapshotData,
    };
    this._checkpoints.push(cp);
    return cp;
  }

  // -------------------------------------------------------------------------
  // Serialization (for StateDB persistence)
  // -------------------------------------------------------------------------

  toRecord(sessionId: string): GoalRecordData {
    return {
      id: this.id,
      sessionId,
      parentGoalId: this.parentId,
      status: this._status,
      description: this.description,
      tokenBudget: this._tokenBudget ?? undefined,
      tokensUsed: this._tokensUsed,
      turnCount: this._turnCount,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      checkpoint:
        this._checkpoints.length > 0
          ? JSON.stringify(this._checkpoints)
          : undefined,
    };
  }

  static fromRecord(record: GoalRecordData): Goal {
    const goal = Object.create(Goal.prototype) as Goal;
    (goal as any).id = record.id;
    (goal as any).description = record.description;
    (goal as any).parentId = record.parentGoalId;
    (goal as any).createdAt = record.createdAt;
    (goal as any)._status = record.status;
    (goal as any)._tokenBudget = record.tokenBudget ?? null;
    (goal as any)._costBudgetUsd = null;
    (goal as any)._tokensUsed = record.tokensUsed;
    (goal as any)._costUsed = 0;
    (goal as any)._turnCount = record.turnCount;
    (goal as any)._updatedAt = record.updatedAt;
    (goal as any)._checkpoints = record.checkpoint
      ? JSON.parse(record.checkpoint)
      : [];
    return goal;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetCheckResult {
  readonly exceeded: boolean;
  readonly reason?: string;
  readonly limitType?: "usage" | "budget";
}

export interface GoalRecordData {
  id: string;
  sessionId: string;
  parentGoalId?: string;
  status: GoalStatus;
  description: string;
  tokenBudget?: number;
  tokensUsed: number;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  checkpoint?: string;
}

export class GoalTransitionError extends Error {
  constructor(
    public readonly from: GoalStatus,
    public readonly to: GoalStatus,
  ) {
    super(`invalid goal transition: ${from} → ${to}`);
    this.name = "GoalTransitionError";
  }
}

// ---------------------------------------------------------------------------
// GoalRegistry — in-memory store for active goals
// ---------------------------------------------------------------------------

export class GoalRegistry {
  private goals = new Map<string, Goal>();

  create(opts: GoalOptions): Goal {
    const goal = new Goal(opts);
    this.goals.set(goal.id, goal);
    return goal;
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  remove(id: string): boolean {
    return this.goals.delete(id);
  }

  listActive(): Goal[] {
    return [...this.goals.values()].filter((g) => g.isActive);
  }

  listAll(): Goal[] {
    return [...this.goals.values()];
  }

  listByStatus(status: GoalStatus): Goal[] {
    return [...this.goals.values()].filter((g) => g.status === status);
  }

  get size(): number {
    return this.goals.size;
  }

  clear(): void {
    this.goals.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let goalRegistry: GoalRegistry | null = null;

export function getGoalRegistry(): GoalRegistry {
  if (goalRegistry === null) {
    goalRegistry = new GoalRegistry();
  }
  return goalRegistry;
}

export function resetGoalRegistry(): void {
  goalRegistry = null;
}
