/**
 * Frozen kernel contracts (docs/63 §A0, WP-00).
 *
 * These types are the interop boundary for the effect-transaction foundation.
 * Everything in the parity program — durable journal, workspace authority,
 * policy engine, effect runtime, session kernel — is written against the shapes
 * declared here, so they change only through the schema-version rules below.
 *
 * Compatibility rule (docs/63 §A9): a release reads schema N and N−1 and writes
 * only N. Adding an optional field is a compatible change and does not bump the
 * version. Removing a field, renaming one, or narrowing a union does bump it,
 * and needs a reader for the previous shape before it ships.
 *
 * Deliberately absent: provider internals, engine message formats, and UI
 * shapes. The kernel records opaque adapter state (`EngineSessionState`) rather
 * than normalizing what each provider does, so engines stay free to evolve.
 */

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/** Current envelope schema. Bump only for an incompatible change. */
export const KERNEL_SCHEMA_VERSION = 1;

/** Lowest schema a reader in this release accepts (N−1, floored at 1). */
export const KERNEL_MIN_READ_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A path that `WorkspaceAuthority` has already resolved and confined. Tools
 * must not re-derive these from user input: the whole point is that symlink
 * resolution and containment happened once, centrally, before any policy
 * decision was recorded against the result.
 */
export interface CanonicalPath {
  /** Absolute, symlink-resolved path. */
  readonly canonical: string;
  /** Canonical root of the workspace that authorized this path. */
  readonly workspaceRoot: string;
  /** `canonical` relative to `workspaceRoot`, always forward-slashed. */
  readonly relative: string;
}

/**
 * What a file looked like when it was observed. `contentHash` is the
 * compare-and-swap token: an effect that mutates a file states the hash it
 * expects, and the write is refused if the file no longer matches.
 *
 * All three observation fields are null for a path that did not exist, which
 * is itself a meaningful expectation ("create only if still absent").
 */
export interface FileIdentity {
  readonly path: CanonicalPath;
  /** SHA-256 of the file's bytes, or null when the file was absent. */
  readonly contentHash: string | null;
  readonly sizeBytes: number | null;
  readonly mtimeMs: number | null;
}

/**
 * A directory listing or glob result, stamped so a later reader can tell
 * whether the set of matching entries has changed. Individual file contents
 * are tracked by `FileIdentity`; this covers "what exists" rather than "what is
 * in it".
 */
export interface DirectoryQueryStamp {
  readonly root: CanonicalPath;
  /** The glob or listing predicate, recorded verbatim for replay. */
  readonly query: string;
  /** Stable digest over the sorted matched relative paths. */
  readonly entriesDigest: string;
  readonly matchCount: number;
}

/**
 * Everything an agent observed about the workspace while producing a result.
 *
 * `generation` is the workspace generation current at observation time. In a
 * shared workspace a reader's output is provisional until its ReadSet is
 * revalidated against the live generation (docs/63 §A5); that check is what
 * makes stale advice detectable rather than silently wrong.
 */
export interface ReadSet {
  readonly generation: number;
  readonly files: readonly FileIdentity[];
  readonly directories: readonly DirectoryQueryStamp[];
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Typed content, referenced rather than inlined.
 *
 * Images and attachments carry a content-addressed `ref` instead of base64
 * bytes so the journal stays small enough to replay and diff. The blob store
 * owns the bytes; the journal owns the reference and the digest that proves
 * which bytes they were.
 *
 * The text/tool_use/tool_result/reasoning members mirror `ProviderMessage`
 * content in src/providers/index.ts so an adapter can map between them without
 * loss. `image` and `resource` are the additions that shape has no room for.
 */
export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly toolUseId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: string;
      readonly isError?: boolean;
    }
  /** Opaque provider reasoning continuity token; never interpreted here. */
  | { readonly type: "reasoning"; readonly signature: string }
  | {
      readonly type: "image";
      readonly ref: BlobRef;
      /** IANA media type, e.g. "image/png". */
      readonly mediaType: string;
    }
  | {
      readonly type: "resource";
      readonly ref: BlobRef;
      readonly mediaType: string;
      /** Where the bytes came from, for provenance and re-read. */
      readonly origin?: CanonicalPath;
    };

/** Content-addressed handle into the blob store. */
export interface BlobRef {
  /** SHA-256 of the bytes, lowercase hex. Also the store key. */
  readonly digest: string;
  readonly sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Whether an attempt may be retried automatically after an unknown outcome.
 *
 * This is the field that decides recovery behaviour, so it is stated per
 * request rather than inferred from the tool name: a tool is not inherently
 * safe or unsafe, a specific call is.
 */
export type IdempotencyClass =
  /** Replaying produces the same result and no additional effect. */
  | "idempotent"
  /**
   * Replaying may duplicate a side effect. Never retried automatically; an
   * unresolved attempt needs reconciliation or an explicit user decision
   * (docs/63 §A0).
   */
  | "mutating"
  /** Effect is unknown to the kernel; treated as strictly as `mutating`. */
  | "unknown";

/** Coarse class a policy rule and an approval grant are scoped to. */
export type OperationClass = "file.read" | "file.write" | "process.exec" | "network.request";

interface OperationRequestBase {
  /** Stable ID for this attempt; the journal's correlation key. */
  readonly operationId: string;
  readonly idempotency: IdempotencyClass;
  /** Tool that requested the operation, for attribution and rule matching. */
  readonly toolName: string;
}

export interface FileReadRequest extends OperationRequestBase {
  readonly kind: "file.read";
  readonly path: CanonicalPath;
}

export interface FileWriteRequest extends OperationRequestBase {
  readonly kind: "file.write";
  readonly path: CanonicalPath;
  /**
   * The state the caller believes the file is in. The write is refused when
   * reality disagrees, which is what makes a concurrent modification a clean
   * failure instead of a lost update.
   */
  readonly expected: FileIdentity;
}

export interface ProcessExecRequest extends OperationRequestBase {
  readonly kind: "process.exec";
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: CanonicalPath;
}

export interface NetworkRequest extends OperationRequestBase {
  readonly kind: "network.request";
  readonly method: string;
  readonly url: string;
}

/**
 * Discriminated effect request (docs/63 §A2).
 *
 * Policy is evaluated against this, not against `(toolName, unknownInput)`, so
 * a decision and the approval grant derived from it name an exact resource and
 * operation class. That is what lets a grant be scoped and audited instead of
 * standing in for "this tool, any argument".
 */
export type OperationRequest =
  | FileReadRequest
  | FileWriteRequest
  | ProcessExecRequest
  | NetworkRequest;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** How long an approval applies. Session scope is the default (docs/63). */
export type GrantScope = "one-shot" | "session" | "persistent";

export interface PolicyDecision {
  readonly allowed: boolean;
  /** Present when `allowed` is false; safe to show a user verbatim. */
  readonly reason?: string;
  /** Set when the decision came from an approval rather than a standing rule. */
  readonly grant?: {
    readonly scope: GrantScope;
    readonly operationClass: OperationClass;
    /** Resource the grant is bound to; a grant never widens beyond it. */
    readonly resource: string;
  };
  /** Identifies the rule or approval that decided, for audit. */
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Terminal state of an attempt.
 *
 * `outcome_unknown` is a first-class result, not an error case. A crash between
 * "started executing" and "recorded the result" leaves the kernel genuinely
 * unable to say whether the effect landed, and recording that honestly is what
 * prevents a blind retry from duplicating a mutation.
 */
export type EffectOutcome =
  | {
      readonly kind: "completed";
      readonly operationId: string;
      /** Observed state after a successful mutation, for the next expectation. */
      readonly resulting?: FileIdentity;
      readonly output?: string;
    }
  | {
      readonly kind: "denied";
      readonly operationId: string;
      readonly decision: PolicyDecision;
    }
  | {
      readonly kind: "failed";
      readonly operationId: string;
      readonly message: string;
      /** True when the failure was a compare-and-swap mismatch. */
      readonly conflict?: boolean;
    }
  | {
      readonly kind: "outcome_unknown";
      readonly operationId: string;
      readonly reason: string;
    };

/** Convenience guard: did this attempt reach a state the kernel can trust? */
export function isResolved(outcome: EffectOutcome): boolean {
  return outcome.kind !== "outcome_unknown";
}

/**
 * Whether recovery may re-run this attempt without asking. Requires both a
 * resolved-or-safe idempotency class and a non-mutating request; an unresolved
 * mutating attempt always needs a human or a reconciler.
 */
export function isAutoReplayable(
  request: OperationRequest,
  outcome: EffectOutcome,
): boolean {
  if (isResolved(outcome)) return false;
  return request.idempotency === "idempotent";
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * Kernel event types. The journal is the source of truth; UI and lane events
 * are projections of it, never the other way round (docs/63 §A0 gate).
 */
export type KernelEventType =
  /** An attempt is authorized and about to execute. Written before the effect. */
  | "AttemptPrepared"
  /** An attempt reached a terminal state. Written after the effect. */
  | "AttemptResolved"
  | "TurnStarted"
  | "TurnEnded"
  | "SessionCreated"
  | "EngineStateRecorded";

/**
 * Recorded before an effect executes (step 3 of the durability order).
 *
 * It carries the expected workspace state so recovery can compare intent
 * against reality and decide whether the effect landed, which is only possible
 * if the expectation was durable *before* execution.
 */
export interface AttemptPreparedPayload {
  readonly request: OperationRequest;
  readonly decision: PolicyDecision;
  /** Workspace generation the expectation was formed against. */
  readonly generation: number;
}

export interface AttemptResolvedPayload {
  readonly outcome: EffectOutcome;
}

/**
 * Opaque per-engine resume state. The kernel stores and returns it verbatim.
 *
 * Typing `data` as `unknown` is deliberate: the kernel coordinates sessions
 * without becoming a second authority on provider internals (docs/63 §A1), and
 * a structurally-typed field here would quietly become one.
 */
export interface EngineSessionState {
  readonly engineId: string;
  readonly data: unknown;
  /** Engine-reported compaction boundary, recorded but not interpreted. */
  readonly compactionBoundary?: number;
}

/**
 * The journal record.
 *
 * `seq` is assigned by the store and is gap-free per session, so a reader can
 * detect a lost record rather than silently skipping one. `causationId` links a
 * resolution back to the attempt that produced it.
 */
export interface EventEnvelope<T = unknown> {
  readonly schema: number;
  /** Monotonic, gap-free, 1-based within a session. */
  readonly seq: number;
  readonly eventId: string;
  readonly sessionId: string;
  readonly ts: number;
  readonly type: KernelEventType;
  readonly payload: T;
  /** `operationId` or `eventId` this record is a consequence of. */
  readonly causationId?: string;
}

/** Envelope with its payload narrowed by event type. */
export type KernelEvent =
  | EventEnvelope<AttemptPreparedPayload> & { readonly type: "AttemptPrepared" }
  | EventEnvelope<AttemptResolvedPayload> & { readonly type: "AttemptResolved" }
  | EventEnvelope<EngineSessionState> & { readonly type: "EngineStateRecorded" }
  | EventEnvelope<Record<string, unknown>>;

/** True when this reader can interpret the envelope (N and N−1). */
export function isReadableSchema(schema: number): boolean {
  return schema >= KERNEL_MIN_READ_SCHEMA_VERSION && schema <= KERNEL_SCHEMA_VERSION;
}
