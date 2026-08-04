/**
 * Closing out attempts that never reached a terminal record (docs/67 `WP-00a`).
 *
 * A crash between performing an effect and recording its result leaves an
 * `AttemptPrepared` with no `AttemptResolved`. That gap is the whole reason the
 * pre-decision record exists, and until this module had a caller the records
 * were written and never read: a restart found the dangling attempt and did
 * nothing with it.
 *
 * The logic lived on `EffectRuntime`, which reads and writes the session store.
 * Attempt records moved to their own always-durable journal when the audit and
 * history journals were split, so the reconciliation had to become callable
 * against either — hence a function over the narrow read/append view below,
 * with `EffectRuntime.recover()` delegating to it. One implementation rather
 * than two, for the same reason `outcomeFor` is shared: a second copy is how the
 * restart path and the runtime start disagreeing about what a dangling record
 * means.
 *
 * **Scope is one session, deliberately.** Reconciling every session found in a
 * workspace would be wrong, not merely broad: a concurrent agent holding a
 * legitimately in-flight prepare is indistinguishable, from the outside, from a
 * crashed one, so a sweep would declare `outcome_unknown` for effects that are
 * about to resolve normally. A caller may only reconcile a session it owns,
 * because that is the one case where "no other process is running this" is
 * known rather than guessed. The cost is honest and worth stating: a crashed
 * session nobody resumes keeps its dangling records forever.
 */

import type {
  AttemptPreparedPayload,
  AttemptResolvedPayload,
  EffectOutcome,
  EventEnvelope,
} from "./contracts.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";
import type { RecoveryReport, UnresolvedAttempt } from "./effect-runtime.js";
import { isAutoReplayable } from "./contracts.js";

/**
 * The part of a journal reconciliation needs: replay the records, add one.
 *
 * Structural rather than the concrete store so the audit journal and the
 * session store both satisfy it without either depending on the other.
 */
export interface AttemptJournalView {
  read(sessionId: string): AsyncIterable<{ readonly type: string }>;
  append(event: {
    readonly sessionId: string;
    readonly type: "AttemptResolved";
    readonly payload: AttemptResolvedPayload;
    readonly causationId?: string;
  }): Promise<unknown>;
}

export interface ReconcileDeps {
  readonly sessionId: string;
  readonly journal: AttemptJournalView;
  readonly authority: WorkspaceAuthority;
}

/**
 * Records a terminal outcome for every attempt left dangling, and reports each
 * with enough context to reconcile by hand.
 *
 * Mutating attempts are never replayed, whatever the workspace looks like,
 * because nothing here can tell "never ran" from "ran but was not recorded" —
 * and of those two, replaying the second is the one that does damage.
 */
export async function reconcileAttempts(deps: ReconcileDeps): Promise<RecoveryReport> {
  // Initialized here rather than trusted to the caller. It is one idempotent
  // realpath, and the alternative fails only when there is something to
  // reconcile -- so a caller that forgot would ship, work in every test that has
  // nothing dangling, and throw for the first time during a real recovery.
  await deps.authority.init();

  const preparedById = new Map<string, EventEnvelope<AttemptPreparedPayload>>();
  const resolved = new Set<string>();

  for await (const record of deps.journal.read(deps.sessionId)) {
    if (record.type === "AttemptPrepared") {
      const envelope = record as unknown as EventEnvelope<AttemptPreparedPayload>;
      preparedById.set(envelope.payload.request.operationId, envelope);
    } else if (record.type === "AttemptResolved") {
      const envelope = record as unknown as EventEnvelope<AttemptResolvedPayload>;
      resolved.add(envelope.payload.outcome.operationId);
    }
  }

  const unresolved: UnresolvedAttempt[] = [];
  for (const [operationId, prepared] of preparedById) {
    if (resolved.has(operationId)) continue;

    const { request } = prepared.payload;
    // Whether the workspace still looks like what the attempt expected. Not a
    // verdict on whether the write happened — an identical rewrite is
    // indistinguishable from no write at all — but the input a human needs.
    const workspaceUnchanged =
      request.kind === "file.write" ? await deps.authority.matches(request.expected) : true;

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

    // Written before returning, so a crash during recovery does not have to be
    // recovered from differently: the attempt is now terminal either way.
    await deps.journal.append({
      sessionId: deps.sessionId,
      type: "AttemptResolved",
      payload: { outcome },
      causationId: operationId,
    });
  }

  return { unresolved, closed: unresolved.length };
}
