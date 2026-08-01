/**
 * Engine-agnostic resume, backed by the kernel journal (docs/63 `WP-08`).
 *
 * What this replaces: `--resume` resolved sessions through the Claude Agent
 * SDK's own store and wrapped whatever it found as
 * `{ engineId: "claude-agent-sdk", … }`. For the default engine that produced a
 * refusal — "hardened-native engine cannot resume snapshots produced by another
 * engine" — which is the correct answer to the wrong question. Nothing had
 * produced a native snapshot to find: the engines carry a `persistSnapshot` that
 * writes only when `sessionDir` is set, and no production caller ever set it, so
 * resume was structurally impossible for every engine but one.
 *
 * The journal already had the right slot. `EngineStateRecorded` carries
 * `EngineSessionState { engineId, data }`, which is `SessionSnapshot` under
 * another name, and the frozen contract keeps `data` opaque so engines stay free
 * to evolve. Recording the state an engine hands back, and returning it with the
 * `engineId` it was recorded under, makes resume work for whichever engine owns
 * the session and keeps cross-engine resume failing closed for the right reason.
 *
 * It also makes the `WP-07` importer's output reachable. The importer writes the
 * same `EngineStateRecorded` record, so an imported session resumes through this
 * reader with no import-specific path — which is what "resumable" in an import
 * verdict was asserting before anything could act on it.
 *
 * Durability is deliberately not on by default. A session journal is
 * conversation history, and the storage decision locked in `WP-00` is encrypted
 * with 90-day retention, ephemeral with a warning when no key provider exists,
 * and never plaintext. No key provider is implemented yet, so the default here
 * resolves through `resolveSessionStorage` to ephemeral and says so. Durable
 * storage is reachable only through an opt-in that names what it costs.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { EventStore } from "../kernel/event-store.js";
import type { EngineSessionState } from "../kernel/contracts.js";
import {
  resolveSessionStorage,
  type SecureKeyProvider,
  type SessionStorageConfig,
} from "../kernel/storage-policy.js";
import type { SessionSnapshot } from "../engine/index.js";
import type { ImportedSessionPayload, Loss } from "./import.js";

/** Journals live under `<workspace>/.openswarm/sessions/<sessionId>/`. */
export const SESSIONS_DIR = path.join(".openswarm", "sessions");

/**
 * The opt-in. Spelled with "unencrypted" in the value rather than as a boolean
 * so that enabling it is a sentence about the tradeoff: the locked decision is
 * that history is encrypted, this is the documented deviation until a key
 * provider exists, and it should not be reachable by setting something to 1.
 */
export const DURABLE_OPT_IN = "unencrypted-durable";

/** Where a session's records go, and what the user was told about it. */
export type SessionPersistence =
  | {
      readonly kind: "durable";
      readonly rootDir: string;
      /**
       * Always true for now. Present so the call sites that warn are the ones a
       * key provider will later have to update, rather than a boolean that
       * silently starts meaning something else.
       */
      readonly unencrypted: true;
      readonly warning: string;
    }
  | { readonly kind: "ephemeral"; readonly warning: string };

/**
 * A provider that has no key, which is the truthful state of things: `WP-00`
 * froze the policy and left selecting OS/headless key providers as a follow-up
 * explicitly gated "before durable rollout". Naming it here rather than
 * bypassing the policy means the default path produces the policy's own warning
 * text, and wiring a real provider later is a change at one call site.
 */
export const noKeyProvider: SecureKeyProvider = {
  id: "none-configured",
  getKey: async () => null,
};

/**
 * Decides where this session's history goes.
 *
 * The opt-in is checked before the policy rather than modelled inside it.
 * `ResolvedStorage` has no plaintext variant on purpose — there is nothing to
 * silently degrade *to* — and adding one to carry this deviation would undo the
 * property that makes the policy worth having.
 */
export async function resolvePersistence(options: {
  readonly workspaceDir: string;
  readonly optIn?: string | undefined;
  readonly config?: SessionStorageConfig;
  readonly keyProvider?: SecureKeyProvider;
}): Promise<SessionPersistence> {
  if (options.optIn === DURABLE_OPT_IN) {
    return {
      kind: "durable",
      rootDir: path.join(options.workspaceDir, SESSIONS_DIR),
      unencrypted: true,
      warning:
        "Session history is being written to disk unencrypted, because " +
        `OPENSWARM_SESSION_STORE=${DURABLE_OPT_IN} was set. The default is to ` +
        "keep no history until a secure key provider is available.",
    };
  }

  const resolved = await resolveSessionStorage(
    options.config ?? {},
    options.keyProvider ?? noKeyProvider,
  );

  if (resolved.kind === "ephemeral") {
    return { kind: "ephemeral", warning: resolved.warning };
  }

  // Unreachable until a key provider exists. Refusing rather than writing
  // plaintext keeps the failure loud if one is wired up without teaching this
  // module to encrypt.
  throw new Error(
    "resolveSessionStorage returned encrypted storage, but the session journal " +
      "cannot encrypt yet; refusing to write history in the clear",
  );
}

/**
 * Records the state an engine handed back after a turn it acknowledged.
 *
 * Called per acknowledged turn rather than at exit, because the point is
 * surviving the exits nobody scheduled. `append` does not resolve until the
 * record is durable, so a caller that awaits this knows the turn is recoverable.
 */
export async function recordTurnState(
  store: EventStore,
  sessionId: string,
  snapshot: SessionSnapshot,
  compactionBoundary?: number,
): Promise<void> {
  const payload: EngineSessionState = {
    engineId: snapshot.engineId,
    data: snapshot.data,
    ...(compactionBoundary !== undefined && { compactionBoundary }),
  };
  await store.append({ sessionId, type: "EngineStateRecorded", payload });
}

/** Why a session that exists on disk still cannot be continued. */
export type ResumeRefusal =
  | { readonly reason: "no-such-session" }
  | { readonly reason: "no-recorded-state" }
  | {
      readonly reason: "read-only-import";
      readonly losses: readonly Loss[];
      readonly sourceKind: string;
    };

export type ResumeState =
  | { readonly kind: "ok"; readonly snapshot: SessionSnapshot; readonly turns: number }
  | { readonly kind: "refused"; readonly refusal: ResumeRefusal };

/**
 * Reads the state to resume a session from.
 *
 * The last `EngineStateRecorded` wins: earlier records are the history of the
 * conversation's state, not alternatives to it. The `engineId` travels with the
 * snapshot untouched, so an engine handed someone else's state still refuses —
 * the difference from before is that the refusal is now about a real mismatch
 * rather than about a label this layer invented.
 *
 * A read-only import is refused with what it lost. The importer decided that
 * question already and wrote the verdict into `SessionCreated`; re-deriving it
 * here would be a second opinion on the same evidence.
 */
export async function readResumeState(
  store: EventStore,
  sessionId: string,
): Promise<ResumeState> {
  let latest: EngineSessionState | undefined;
  let turns = 0;
  let provenance: ImportedSessionPayload | undefined;
  let sawAnything = false;

  for await (const record of store.read(sessionId)) {
    sawAnything = true;
    if (record.type === "SessionCreated") {
      const payload = record.payload as Partial<ImportedSessionPayload>;
      if (payload.origin === "import") provenance = payload as ImportedSessionPayload;
      continue;
    }
    if (record.type === "EngineStateRecorded") {
      latest = record.payload as EngineSessionState;
      turns += 1;
    }
  }

  if (!sawAnything) return { kind: "refused", refusal: { reason: "no-such-session" } };

  if (provenance?.readOnly === true) {
    return {
      kind: "refused",
      refusal: {
        reason: "read-only-import",
        losses: provenance.losses,
        sourceKind: provenance.sourceKind,
      },
    };
  }

  if (latest === undefined) {
    return { kind: "refused", refusal: { reason: "no-recorded-state" } };
  }

  return {
    kind: "ok",
    snapshot: { engineId: latest.engineId, data: latest.data },
    turns,
  };
}

/**
 * Most recently written session under `rootDir`, or undefined when there is
 * none.
 *
 * Ordered by the journal's modification time rather than by session id: ids are
 * UUIDs for live sessions and derived hashes for imported ones, so they sort
 * into an order that has nothing to do with when anybody last worked.
 */
export async function resolveLatest(rootDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fsp.readdir(rootDir);
  } catch {
    return undefined;
  }

  let newest: { sessionId: string; mtimeMs: number } | undefined;
  for (const sessionId of entries) {
    const journal = path.join(rootDir, sessionId, "journal.jsonl");
    try {
      const stat = await fsp.stat(journal);
      if (newest === undefined || stat.mtimeMs > newest.mtimeMs) {
        newest = { sessionId, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // A directory with no journal is not a session yet.
    }
  }
  return newest?.sessionId;
}

/** Human-readable refusal, for the surfaces that have to explain themselves. */
export function explainRefusal(refusal: ResumeRefusal, sessionId: string): string {
  switch (refusal.reason) {
    case "no-such-session":
      return `no session ${sessionId} on disk`;
    case "no-recorded-state":
      return `session ${sessionId} recorded no engine state to resume from`;
    case "read-only-import":
      return (
        `session ${sessionId} was imported from a ${refusal.sourceKind} source and ` +
        `is read-only; it cannot reconstruct ${refusal.losses.map((l) => l.kind).join(", ")}`
      );
  }
}
