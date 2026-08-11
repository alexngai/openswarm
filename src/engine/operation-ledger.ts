/**
 * Operation ledger for a single turn (docs/67 `WP-05`).
 *
 * A turn's provider request can be retried. The retried stream re-announces
 * the tool calls the failed one announced, and without a record of what the
 * earlier attempt already did, the engine executes them again — which for a
 * read costs a little time and for a write is a second mutation nobody asked
 * for. Forgetting the earlier attempt's promises, which is what the engine did
 * before this existed, keeps the stale *results* from being used but does not
 * unmake the effects.
 *
 * The ledger gives each call an identity that survives the retry and records
 * what happened to it, so a re-announced call can be answered from the record
 * instead of being performed twice.
 *
 * It is deliberately per-turn and in-memory. Crash recovery across process
 * restarts is the kernel's journal (`src/kernel/event-store.ts`), which records
 * the same distinctions durably; this is the same bookkeeping at the one place
 * a retry actually happens, and the two share a vocabulary rather than a
 * storage layer.
 */

import { createHash } from "node:crypto";

import type { EffectOutcome, IdempotencyClass } from "../kernel/contracts.js";
import type { ToolAccesses } from "../tools/access.js";
import type { ToolResult } from "../tools/types.js";

/**
 * How a call's declared accesses translate into whether repeating it is safe.
 *
 * This reads the existing access declarations rather than adding a second
 * per-tool annotation, so a tool cannot be parallel-safe to the scheduler and
 * replayable to the ledger by disagreeing with itself. The mapping is
 * deliberately pessimistic in both unclear directions: `all()` means the tool
 * could not name what it touches, which is exactly when replaying it must not
 * be assumed safe, and a network call that is not a plain retrieval is treated
 * as mutating because nothing here can see what the far side did with it.
 */
export function idempotencyOf(accesses: ToolAccesses): IdempotencyClass {
  let sawUnknown = false;
  let sawMutation = false;

  for (const access of accesses) {
    switch (access.kind) {
      case "all":
        sawUnknown = true;
        break;
      case "file":
        if (access.operation === "write" || access.operation === "readwrite") {
          sawMutation = true;
        }
        break;
      case "network": {
        // GET and HEAD are defined to be safe to repeat; anything else,
        // including the `CALL` used for MCP servers and plugins, may not be.
        const method = access.method.toUpperCase();
        if (method !== "GET" && method !== "HEAD") sawMutation = true;
        break;
      }
    }
  }

  if (sawUnknown) return "unknown";
  if (sawMutation) return "mutating";
  // Includes the empty declaration, which is a tool that touches nothing
  // observable and is therefore free to repeat.
  return "idempotent";
}

/** What the ledger knows about one logical operation. */
export type OperationRecord =
  | {
      readonly kind: "in_flight";
      readonly id: string;
      readonly idempotency: IdempotencyClass;
      readonly promise: Promise<ToolResult>;
    }
  | {
      readonly kind: "completed";
      readonly id: string;
      readonly idempotency: IdempotencyClass;
      /** Proven outcome: the tool ran and said what happened. */
      readonly result: ToolResult;
    }
  | {
      readonly kind: "outcome_unknown";
      readonly id: string;
      readonly idempotency: IdempotencyClass;
      readonly reason: string;
    };

/** What to do with a call the ledger has seen before. */
export type ReplayDecision =
  /** No prior attempt, or repeating it is free. */
  | { readonly kind: "dispatch" }
  /** An earlier attempt already did this and said what happened. */
  | { readonly kind: "reuse"; readonly result: ToolResult }
  /** An earlier attempt is still doing it. */
  | { readonly kind: "await"; readonly promise: Promise<ToolResult> }
  /** An earlier attempt may or may not have done it, and it cannot be redone. */
  | { readonly kind: "refuse"; readonly message: string };

/**
 * Decide what a re-announced call should do.
 *
 * The asymmetry is the point. An idempotent call is dispatched again, because
 * a fresh read of a file is more useful than a remembered one and costs
 * nothing but time. A mutating one is never dispatched twice: if the earlier
 * attempt proved its outcome, that outcome is the honest answer, and if it did
 * not, the only honest answer is that nobody knows — which is a refusal, not a
 * retry. This is `isAutoReplayable` from the kernel contracts, applied at the
 * point a retry happens.
 */
export function decideReplay(
  record: OperationRecord | undefined,
  idempotency: IdempotencyClass,
): ReplayDecision {
  if (record === undefined) return { kind: "dispatch" };

  // Deduplicate regardless of class: two attempts of the same operation
  // running at once is the duplication this exists to prevent, and the
  // in-flight one already has the gate's blessing.
  if (record.kind === "in_flight") return { kind: "await", promise: record.promise };

  if (idempotency === "idempotent") return { kind: "dispatch" };

  if (record.kind === "completed") return { kind: "reuse", result: record.result };

  return {
    kind: "refuse",
    message:
      `operation was attempted before this retry and its outcome is unknown ` +
      `(${record.reason}). It is not safe to repeat automatically: re-read the ` +
      `affected state and decide, rather than assuming it did or did not happen.`,
  };
}

/**
 * Closes out the attempts the gate prepared (docs/67 `WP-00a` remainder).
 *
 * Narrow in the mirror image of the gate's `AttemptRecorder`: the gate can only
 * prepare and this can only resolve, so neither side can write the other's half
 * and the journal cannot acquire a writer that resolves an attempt before it
 * executed.
 */
export interface AttemptResolver {
  resolve(outcome: EffectOutcome): Promise<void>;
}

/**
 * The terminal record for one attempt, derived from what the tool reported.
 *
 * Exported because two dispatch paths need it and must not answer differently:
 * the ledger brackets the eager path, and the batch path has no ledger and
 * resolves against its own results. A second copy of this mapping is how one
 * path starts calling a returned error `outcome_unknown`, which would tell
 * recovery that an effect it can see the result of might not have happened.
 *
 * A success records only that it completed. The tool's output is the one field
 * that can carry arbitrary file content, and the audit journal is durable
 * unconditionally because it holds paths and decisions instead. A failure keeps
 * a bounded message, because a refusal nobody can read is not much of an audit
 * trail; redaction for anything a projection quotes is `WP-12`'s.
 */
export function outcomeFor(
  operationId: string,
  result: ToolResult | undefined,
  unknownReason?: string,
): EffectOutcome {
  if (unknownReason !== undefined) {
    return { kind: "outcome_unknown", operationId, reason: unknownReason };
  }
  if (result?.status === "ok") return { kind: "completed", operationId };
  return {
    kind: "failed",
    operationId,
    message: (result?.message ?? "tool reported no message").slice(0, 512),
  };
}

/**
 * Identity and outcomes for the operations of one turn.
 *
 * Identity has to be computed rather than taken from the provider. A retry is
 * a fresh sampling request, so the `tool_use` ids it returns are its own and
 * may differ from the failed attempt's even when the calls are identical. What
 * does correspond is position: the Nth time a turn asks for a given tool with
 * given arguments is the same logical operation as the Nth time the retried
 * turn asks for it. So the id is a digest over the turn, the tool, the
 * canonical arguments, and that occurrence count — which also keeps two
 * genuinely distinct calls (`echo a` twice) as two operations rather than
 * collapsing them into one.
 *
 * When an `AttemptResolver` is supplied the ledger also writes the terminal half
 * of the durability order to the audit journal. This is the one place that can:
 * the gate records the attempt immediately before execution, and the ledger is
 * what brackets the execution, so it is the only point that knows whether the
 * tool got to say what happened. The distinction it already draws for retries —
 * a returned error is a proven outcome, a thrown one is not — is exactly the
 * distinction the journal needs between `failed` and `outcome_unknown`.
 */
export class TurnLedger {
  private readonly records = new Map<string, OperationRecord>();
  private occurrences = new Map<string, number>();
  /** Attempt ids the gate prepared for a ledger operation, awaiting a terminal record. */
  private readonly prepared = new Map<string, readonly string[]>();

  constructor(
    private readonly turn: number,
    private readonly audit?: AttemptResolver,
  ) {}

  /**
   * Note the attempts the gate prepared for this operation, so settling it also
   * settles them. Separate from `start` because a call can be refused between
   * the gate and the dispatcher, and a prepared attempt still needs closing.
   */
  attach(id: string, preparedOperationIds: readonly string[]): void {
    if (preparedOperationIds.length > 0) this.prepared.set(id, preparedOperationIds);
  }

  /**
   * Writes the terminal record for every attempt the gate prepared under `id`.
   *
   * A success records only that it completed. The tool's output is deliberately
   * not quoted: it is the one field that can carry arbitrary file content, and
   * the audit journal's durability is unconditional precisely because it holds
   * paths and decisions rather than content. A failure records its message,
   * bounded, because a refusal nobody can read is not much of an audit trail —
   * redaction discipline for anything a projection quotes is `WP-12`'s.
   */
  private async resolveAttempts(id: string, result: ToolResult | undefined, unknown?: string) {
    const ids = this.prepared.get(id);
    if (ids === undefined || this.audit === undefined) return;
    this.prepared.delete(id);

    for (const operationId of ids) {
      await this.audit.resolve(outcomeFor(operationId, result, unknown));
    }
  }

  /**
   * Start a new attempt at this turn. Occurrence counts reset so the retried
   * attempt's calls line up with the failed attempt's; the records do not,
   * because they are the whole point.
   */
  beginAttempt(): void {
    this.occurrences = new Map();
  }

  /** The logical operation id for this occurrence of this call. */
  identify(name: string, input: unknown): string {
    const shape = `${name}\u0000${canonicalJson(input)}`;
    const seen = (this.occurrences.get(shape) ?? 0) + 1;
    this.occurrences.set(shape, seen);
    return createHash("sha256")
      .update(`${this.turn}\u0000${shape}\u0000${seen}`)
      .digest("hex")
      .slice(0, 32);
  }

  get(id: string): OperationRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Record an operation as under way and settle it when it finishes.
   *
   * A returned error is a proven outcome — the tool ran and reported failure —
   * while a thrown one is not: the dispatcher did not get to say whether the
   * effect happened. That distinction is what separates a call that can be
   * answered from the record from one that can only be refused.
   */
  start(
    id: string,
    idempotency: IdempotencyClass,
    run: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const promise = run().then(
      async (result) => {
        this.records.set(id, { kind: "completed", id, idempotency, result });
        // Awaited before the result is handed back, so the acknowledgement the
        // caller receives is never ahead of the durable record of it (step 6
        // follows step 5). A journal write that failed must not be reported as a
        // completed effect.
        await this.resolveAttempts(id, result);
        return result;
      },
      async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.records.set(id, { kind: "outcome_unknown", id, idempotency, reason });
        await this.resolveAttempts(id, undefined, reason);
        throw err;
      },
    );
    this.records.set(id, { kind: "in_flight", id, idempotency, promise });
    return promise;
  }

  /** Record a result the ledger did not run itself, such as a gate refusal. */
  settle(id: string, idempotency: IdempotencyClass, result: ToolResult): void {
    this.records.set(id, { kind: "completed", id, idempotency, result });
    void this.resolveAttempts(id, result);
  }

  /**
   * Record that an operation's outcome cannot be proven. Used when an attempt
   * is abandoned rather than failed — a cancelled turn, or a wait that ran out
   * of patience — where the effect may well have landed.
   */
  markUnknown(id: string, idempotency: IdempotencyClass, reason: string): void {
    this.records.set(id, { kind: "outcome_unknown", id, idempotency, reason });
    void this.resolveAttempts(id, undefined, reason);
  }

  /** Operations that never reached a proven outcome. */
  unresolved(): readonly OperationRecord[] {
    return [...this.records.values()].filter((r) => r.kind !== "completed");
  }

  /** Every record, for assertions and for projecting into a journal. */
  all(): readonly OperationRecord[] {
    return [...this.records.values()];
  }
}

/**
 * Turn a replay decision into the result a turn will report for that call.
 *
 * Every branch produces a result, including the refusal: a call the model made
 * and got no answer to is worse than one it was told about, because it looks
 * from the transcript as though it was never asked.
 */
export function replayResult(
  replay: ReplayDecision,
  dispatch: () => Promise<ToolResult>,
): Promise<ToolResult> {
  switch (replay.kind) {
    case "reuse":
      return Promise.resolve(replay.result);
    case "await":
      return replay.promise;
    case "refuse":
      return Promise.resolve({ status: "error", message: replay.message });
    case "dispatch":
      return dispatch();
  }
}

/**
 * Wait for operations already under way to reach a proven outcome, and record
 * the ones that will not say.
 *
 * This is the cancellation barrier. Abandoning a turn used to mean returning
 * out of the generator with tool calls still running, which reports a
 * cancellation that has not happened yet: the effects continue, land after the
 * turn everyone believes is over, and nothing anywhere says so. Waiting makes
 * the report true.
 *
 * The wait is bounded, because a tool that ignores its abort signal must not be
 * able to hold cancellation open forever. Anything still running when patience
 * runs out is recorded as unknown, which is the accurate description — it may
 * yet succeed, and no one will find out.
 */
export async function settleOutstanding(
  ledger: TurnLedger,
  reason: string,
  timeoutMs: number,
): Promise<void> {
  const pending = ledger.all().filter((r) => r.kind === "in_flight");
  if (pending.length === 0) return;

  await Promise.all(
    pending.map(async (record) => {
      if (record.kind !== "in_flight") return;
      const expired = Symbol("expired");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          // A rejection is already recorded as unknown by `start`; swallow it
          // here so one failing operation cannot abandon the others' waits.
          record.promise.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<typeof expired>((resolve) => {
            timer = setTimeout(() => resolve(expired), timeoutMs);
          }),
        ]);
        if (settled === expired) {
          ledger.markUnknown(record.id, record.idempotency, reason);
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}

/**
 * JSON with object keys in a stable order, so that arguments differing only in
 * key order are one operation rather than two.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
