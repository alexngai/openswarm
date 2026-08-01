/**
 * Effect transaction runtime (docs/67 §A0, WP-00).
 *
 * Implements the durability order that the whole parity program depends on:
 *
 *   1. canonicalize resources through WorkspaceAuthority
 *   2. authorize the discriminated request through PolicyEngine
 *   3. durably append AttemptPrepared (operation id, idempotency class, policy
 *      decision, expected workspace state)
 *   4. execute
 *   5. durably append a terminal result, or outcome_unknown
 *   6. acknowledge to the caller
 *
 * Step 3 is the point of the whole design. Recording the expectation *before*
 * executing is what makes a crash recoverable: without it, a restart finds a
 * changed workspace and no way to tell whether the change was intended, already
 * acknowledged, or half-finished.
 *
 * An unresolved mutating attempt is never replayed automatically. Recovery
 * records outcome_unknown and stops, leaving reconciliation to a human or a
 * reconciler, because a blind retry is exactly how a duplicate mutation
 * happens.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AttemptPreparedPayload,
  AttemptResolvedPayload,
  EffectOutcome,
  EventEnvelope,
  FileIdentity,
  OperationRequest,
} from "./contracts.js";
import { isAutoReplayable } from "./contracts.js";
import type { EventStore } from "./event-store.js";
import type { PolicyEngine } from "./policy-engine.js";
import { PathEscapeError, type WorkspaceAuthority } from "./workspace-authority.js";

/**
 * Points at which a test may simulate a hard kill. Named for the transition
 * they follow, so a fixture can assert the invariant holds on both sides of
 * every step in the order above.
 */
export type FaultPoint =
  | "before-canonicalize"
  | "after-canonicalize"
  | "after-authorize"
  | "after-prepare"
  | "after-execute"
  | "before-resolve"
  | "after-resolve";

/** Thrown by an injected fault; models a process that died mid-transaction. */
export class InjectedFault extends Error {
  constructor(readonly point: FaultPoint) {
    super(`injected fault at ${point}`);
    this.name = "InjectedFault";
  }
}

export interface EffectRuntimeDeps {
  readonly sessionId: string;
  readonly store: EventStore;
  readonly authority: WorkspaceAuthority;
  readonly policy: PolicyEngine;
  /** Simulated crash points; empty in production. */
  readonly faults?: ReadonlySet<FaultPoint>;
}

export interface UnresolvedAttempt {
  readonly request: OperationRequest;
  readonly prepared: EventEnvelope<AttemptPreparedPayload>;
  /** True when the workspace still matches what the attempt expected. */
  readonly workspaceUnchanged: boolean;
  /** True only for an idempotent request; mutating attempts are never replayed. */
  readonly autoReplayable: boolean;
}

export interface RecoveryReport {
  readonly unresolved: readonly UnresolvedAttempt[];
  /** outcome_unknown records written to close out unresolved attempts. */
  readonly closed: number;
}

export class EffectRuntime {
  constructor(private readonly deps: EffectRuntimeDeps) {}

  private fault(point: FaultPoint): void {
    if (this.deps.faults?.has(point)) throw new InjectedFault(point);
  }

  /**
   * Writes a file through the full transaction, guarded by compare-and-swap.
   *
   * `expected` describes the state the caller believes the file is in. When it
   * is omitted the current state is observed and used, which makes the write
   * conditional on nothing having changed between observation and rename.
   */
  async writeFile(
    requestedPath: string,
    content: string,
    expected?: FileIdentity,
  ): Promise<EffectOutcome> {
    const operationId = randomUUID();

    // ---- 1. canonicalize -------------------------------------------------
    this.fault("before-canonicalize");
    let target;
    try {
      target = await this.deps.authority.canonicalize(requestedPath);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        // Refused before anything durable was written: there is no attempt to
        // recover, so this needs no journal record.
        return { kind: "failed", operationId, message: err.message };
      }
      throw err;
    }
    this.fault("after-canonicalize");

    const expectation = expected ?? (await this.deps.authority.identify(target));
    const request: OperationRequest = {
      kind: "file.write",
      operationId,
      idempotency: "mutating",
      toolName: "kernel.writeFile",
      path: target,
      expected: expectation,
    };

    // ---- 2. authorize ----------------------------------------------------
    const decision = await this.deps.policy.authorize(request);
    this.fault("after-authorize");

    if (!decision.allowed) {
      // A denial is durable too: an audit that omits refusals cannot show that
      // policy was enforced.
      const outcome: EffectOutcome = { kind: "denied", operationId, decision };
      await this.append("AttemptResolved", { outcome }, operationId);
      return outcome;
    }

    // ---- 3. durably prepare ---------------------------------------------
    const prepared: AttemptPreparedPayload = {
      request,
      decision,
      generation: this.deps.authority.generation,
    };
    await this.append("AttemptPrepared", prepared, operationId);
    this.fault("after-prepare");

    // ---- 4. execute ------------------------------------------------------
    let outcome: EffectOutcome;
    try {
      outcome = await this.performWrite(request, content);
      this.fault("after-execute");
    } catch (err) {
      if (err instanceof InjectedFault) throw err;
      outcome = {
        kind: "failed",
        operationId,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // ---- 5. durably resolve ---------------------------------------------
    this.fault("before-resolve");
    await this.append("AttemptResolved", { outcome }, operationId);
    this.fault("after-resolve");

    // ---- 6. acknowledge --------------------------------------------------
    return outcome;
  }

  /**
   * Compare-and-swap write. The expectation is checked, the content staged in
   * the same directory, then re-checked immediately before rename to narrow the
   * window in which a concurrent writer could be lost.
   */
  private async performWrite(
    request: Extract<OperationRequest, { kind: "file.write" }>,
    content: string,
  ): Promise<EffectOutcome> {
    const { authority } = this.deps;
    const target = request.path.canonical;

    if (!(await authority.matches(request.expected))) {
      return {
        kind: "failed",
        operationId: request.operationId,
        message: `${request.path.relative} changed since it was read`,
        conflict: true,
      };
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const staged = `${target}.kernel-${request.operationId.slice(0, 8)}.tmp`;
    await fs.writeFile(staged, content, "utf8");

    try {
      if (!(await authority.matches(request.expected))) {
        return {
          kind: "failed",
          operationId: request.operationId,
          message: `${request.path.relative} changed while the write was staged`,
          conflict: true,
        };
      }
      await fs.rename(staged, target);
    } catch (err) {
      await fs.rm(staged, { force: true });
      throw err;
    }

    authority.bumpGeneration();
    return {
      kind: "completed",
      operationId: request.operationId,
      resulting: await authority.identify(request.path),
    };
  }

  /**
   * Replays the journal and closes out attempts that never reached a terminal
   * record — the state a crash between steps 4 and 5 leaves behind.
   *
   * Each unresolved attempt is recorded as outcome_unknown and reported with
   * enough context to reconcile: whether the workspace still matches what the
   * attempt expected, and whether replay would be safe. Mutating attempts are
   * never replayed here regardless, because the runtime cannot distinguish
   * "never ran" from "ran but was not recorded".
   */
  async recover(): Promise<RecoveryReport> {
    const preparedById = new Map<string, EventEnvelope<AttemptPreparedPayload>>();
    const resolved = new Set<string>();

    for await (const record of this.deps.store.read(this.deps.sessionId)) {
      if (record.type === "AttemptPrepared") {
        const envelope = record as EventEnvelope<AttemptPreparedPayload>;
        preparedById.set(envelope.payload.request.operationId, envelope);
      } else if (record.type === "AttemptResolved") {
        const envelope = record as EventEnvelope<AttemptResolvedPayload>;
        resolved.add(envelope.payload.outcome.operationId);
      }
    }

    const unresolved: UnresolvedAttempt[] = [];
    for (const [operationId, prepared] of preparedById) {
      if (resolved.has(operationId)) continue;

      const { request } = prepared.payload;
      const workspaceUnchanged =
        request.kind === "file.write"
          ? await this.deps.authority.matches(request.expected)
          : true;

      const outcome: EffectOutcome = {
        kind: "outcome_unknown",
        operationId,
        reason: "no terminal record found for a prepared attempt",
      };

      unresolved.push({
        request,
        prepared,
        workspaceUnchanged,
        autoReplayable: isAutoReplayable(request, outcome),
      });

      await this.append("AttemptResolved", { outcome }, operationId);
    }

    return { unresolved, closed: unresolved.length };
  }

  private async append(
    type: "AttemptPrepared" | "AttemptResolved",
    payload: AttemptPreparedPayload | AttemptResolvedPayload,
    causationId: string,
  ): Promise<void> {
    await this.deps.store.append({
      sessionId: this.deps.sessionId,
      type,
      payload,
      causationId,
    });
  }
}
