/**
 * The audit journal, split out from session history (docs/67 `WP-00a` remainder).
 *
 * One `journal.jsonl` used to hold two unrelated kinds of record, and the mix
 * made both wrong. Session history — the engine snapshots that carry message
 * text — is governed by the storage rule `WP-00` froze: encrypted with 90-day
 * retention, ephemeral with a warning when no key provider exists, and never
 * plaintext. Attempt records are governed by nothing of the sort, because "did
 * this effect already run?" has to be answerable after a hard kill no matter how
 * the user configured history. Putting them in the same file meant the audit
 * trail inherited history's gate, so recovery and provenance existed only for
 * users who had opted into keeping plaintext conversation logs. That is the
 * inverse of what either policy wants.
 *
 * The two record classes differ in what they contain, which is what makes
 * separating them defensible rather than a convenience. An attempt record
 * carries canonical and relative paths, a tool name, a policy decision, content
 * hashes, sizes, mtimes, and a generation counter. It never carries file content
 * or message text. History carries exactly the text that attempt records do not.
 * So the audit journal is durable unconditionally and history stays behind its
 * policy, and neither is a silent downgrade of the other.
 *
 * Redaction of what a *result* may quote — a tool's output, a cost — belongs
 * with the projections in `WP-12` rather than here; this module's guarantee is
 * narrower and mechanical: the types below cannot carry conversation content
 * because no history event type is assignable to them.
 */

import * as path from "node:path";
import type { KernelEventType } from "./contracts.js";
import { FileEventStore, type EventStore, type NewEvent } from "./event-store.js";

/** Audit journals live under `<workspace>/.openswarm/audit/<sessionId>/`. */
export const AUDIT_DIR = path.join(".openswarm", "audit");

/**
 * Attempt records: what was authorized, what was tried, and how it ended.
 * Durable unconditionally — this is the record recovery reads.
 */
export type AuditEventType = "AttemptPrepared" | "AttemptResolved";

/**
 * Conversation history: session identity, turn boundaries, and opaque engine
 * state. Subject to the `WP-00` storage policy, so it may not exist at all.
 */
export type HistoryEventType =
  | "SessionCreated"
  | "TurnStarted"
  | "TurnEnded"
  | "EngineStateRecorded";

/**
 * Compile-time proof that the two sets partition `KernelEventType` exactly:
 * total (nothing unclassified) and disjoint (nothing in both). Adding a seventh
 * event type without deciding which journal owns it is a type error here, which
 * is the only way this split stays true — a runtime check would be one more
 * thing that agrees with the code until it doesn't.
 */
type Unclassified = Exclude<KernelEventType, AuditEventType | HistoryEventType>;
type Invented = Exclude<AuditEventType | HistoryEventType, KernelEventType>;
type Overlapping = Extract<AuditEventType, HistoryEventType>;

// Each must be `never`; a non-empty type fails to accept `true`.
const _total: Unclassified extends never ? true : never = true;
const _closed: Invented extends never ? true : never = true;
const _disjoint: Overlapping extends never ? true : never = true;
void _total;
void _closed;
void _disjoint;

/** An append restricted to attempt records. */
export interface AuditJournal {
  append<T>(event: NewEvent<T> & { readonly type: AuditEventType }): Promise<unknown>;
  read: EventStore["read"];
  lastSeq: EventStore["lastSeq"];
  close(): Promise<void>;
}

/**
 * Opens the audit journal for a workspace.
 *
 * Deliberately takes no storage configuration and can return no "ephemeral"
 * variant: a caller that could be handed nothing would need a branch for it,
 * and that branch is where an audit trail quietly stops being written. If the
 * directory cannot be created the failure surfaces on first append rather than
 * being swallowed into a no-op writer.
 */
export function openAuditJournal(workspaceDir: string): AuditJournal {
  const store = new FileEventStore(path.join(workspaceDir, AUDIT_DIR));
  return {
    append: (event) => store.append(event),
    read: (sessionId) => store.read(sessionId),
    lastSeq: (sessionId) => store.lastSeq(sessionId),
    close: () => store.close(),
  };
}

/**
 * Narrows a store to the audit half without opening a second one. Used where a
 * store already exists and the calling code should still be unable to write
 * history through it.
 */
export function asAuditJournal(store: EventStore): AuditJournal {
  return {
    append: (event) => store.append(event),
    read: (sessionId) => store.read(sessionId),
    lastSeq: (sessionId) => store.lastSeq(sessionId),
    close: () => store.close(),
  };
}
