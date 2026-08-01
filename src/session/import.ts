/**
 * Legacy session importer (docs/67 `WP-07`, `FX-MIG-SESSION-001`).
 *
 * Sessions predating the kernel journal exist in four shapes on disk: a Claude
 * Agent SDK session id, a `NativeEngine` snapshot, a `HardenedNativeEngine`
 * snapshot, and a team progress checkpoint. This turns each of them into journal
 * records, and — the part that matters more — says what was lost doing it.
 *
 * The honesty is the feature. An import that looks like a session but cannot be
 * resumed, or that can be resumed into a state missing its tool history, is worse
 * than a refusal: the operator finds out by watching the model contradict a tool
 * result it can no longer see. So every import returns an explicit verdict, the
 * verdict is written into the journal rather than only returned to the caller, and
 * a source that cannot be represented at all is archived under its own name
 * instead of being partially converted.
 *
 * What the journal can and cannot hold shapes this directly. `KernelEventType`
 * has no member carrying message content — the frozen contract records session
 * identity, turn boundaries, attempts, and opaque engine state (docs/67 §A9). So
 * message history travels as `EngineStateRecorded.data`, verbatim, which the
 * kernel stores without interpreting. That is lossless for resume and it is not a
 * queryable transcript. Where a source's history cannot even survive that trip,
 * the import is marked read-only and says why.
 *
 * Nothing is converted before the source is copied. A migration that damages the
 * thing it was migrating has no second attempt, and these files are the only copy
 * of work someone already paid for.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { EventStore } from "../kernel/event-store.js";
import type { EngineSessionState } from "../kernel/contracts.js";
import { readSnapshot } from "../swarm/atomic-snapshot.js";

/** What an import could not carry across. */
export type LossKind =
  /**
   * Tool calls and their results survive only as prose. The model can read what
   * happened but cannot be handed the typed exchange, so a provider that keys
   * continuity on tool-use ids will not accept the history.
   */
  | "typed-tool-history"
  /**
   * Reasoning continuity signatures are absent. Providers treat these as opaque
   * proof that a thinking block was theirs; without them a resumed turn starts
   * its reasoning over, which is a cost and a behaviour change rather than an
   * error.
   */
  | "reasoning-continuity"
  /** Images and file attachments are not represented in the source at all. */
  | "attachments"
  /** Turn boundaries cannot be recovered, only the number of turns. */
  | "turn-boundaries"
  /** Token and cost accounting for the imported history is unavailable. */
  | "usage-accounting";

export interface Loss {
  readonly kind: LossKind;
  /** What specifically was missing, for an operator reading the verdict. */
  readonly detail: string;
}

export type LegacyKind =
  | "claude-sdk-session"
  | "native-snapshot"
  | "hardened-native-snapshot"
  | "team-checkpoint";

export interface LegacySource {
  readonly kind: LegacyKind;
  readonly path: string;
  /** Parsed document, as read from disk. */
  readonly document: unknown;
}

/**
 * Written as the `SessionCreated` payload so the verdict lives with the session
 * rather than in the terminal output of whoever ran the migration.
 *
 * Defined here rather than in `src/kernel/contracts.ts` because the contracts are
 * frozen and this is import provenance, not a kernel concept.
 */
export interface ImportedSessionPayload {
  readonly origin: "import";
  readonly sourceKind: LegacyKind;
  readonly sourcePath: string;
  readonly importedAt: number;
  readonly resumable: boolean;
  readonly readOnly: boolean;
  readonly losses: readonly Loss[];
  readonly backupPath: string;
}

export interface ImportOutcome {
  readonly sessionId: string;
  readonly source: LegacySource;
  /** The engine can continue this session. */
  readonly resumable: boolean;
  /** History is present but must not be replayed as a typed exchange. */
  readonly readOnly: boolean;
  readonly losses: readonly Loss[];
  /** Copy taken before anything was written. */
  readonly backupPath: string;
  /** Set when the source was archived rather than converted. */
  readonly archivedPath?: string;
  /** Journal records written. */
  readonly recordsWritten: number;
}

export interface ImportOptions {
  /** Where the pre-migration copy and any archived state are kept. */
  readonly backupDir: string;
  /** Session id to import as. Defaults to one derived from the source. */
  readonly sessionId?: string;
  readonly now?: () => number;
}

/** Raised when a source cannot be read or is not a session at all. */
export class ImportError extends Error {
  constructor(
    readonly sourcePath: string,
    detail: string,
  ) {
    super(`cannot import ${sourcePath}: ${detail}`);
    this.name = "ImportError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Identify what a file is by its shape rather than by its name.
 *
 * Names are unreliable here: a snapshot copied out of a session directory keeps
 * its contents and loses its path, and the two native snapshots are
 * distinguished only by a field. Sniffing is also what makes a wrong guess
 * loud — a file matching nothing is an `ImportError` rather than an import that
 * produces an empty session.
 */
export async function readLegacySource(sourcePath: string): Promise<LegacySource> {
  let raw: string;
  try {
    raw = await fsp.readFile(sourcePath, "utf8");
  } catch (err) {
    throw new ImportError(sourcePath, (err as NodeJS.ErrnoException).code ?? "unreadable");
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new ImportError(sourcePath, "not JSON");
  }

  // A snapshot written through writeSnapshot is inside an envelope. Unwrap it via
  // readSnapshot rather than by reaching for `.data`, so the checksum is actually
  // checked: importing is exactly the wrong moment to accept a document that
  // failed verification, because the result outlives the file it came from and
  // stops being comparable against it.
  if (isRecord(document) && "envelope" in document && "data" in document) {
    const read = await readSnapshot<unknown>(sourcePath);
    if (read.kind !== "ok") {
      throw new ImportError(sourcePath, `checksummed snapshot is ${read.kind === "corrupt" ? read.reason : read.kind}`);
    }
    document = read.data;
  }

  if (!isRecord(document)) throw new ImportError(sourcePath, "not a JSON object");

  // A team checkpoint, which is progress rather than conversation.
  if ("schemaVersion" in document && Array.isArray(document.units)) {
    return { kind: "team-checkpoint", path: sourcePath, document };
  }

  // A SessionSnapshot envelope: { engineId, data }.
  if (typeof document.engineId === "string" && "data" in document) {
    const inner = document.data;
    if (document.engineId === "claude-agent-sdk") {
      return { kind: "claude-sdk-session", path: sourcePath, document };
    }
    if (isRecord(inner) && "retryStats" in inner) {
      return { kind: "hardened-native-snapshot", path: sourcePath, document };
    }
    if (isRecord(inner) && Array.isArray(inner.messages)) {
      return { kind: "native-snapshot", path: sourcePath, document };
    }
    throw new ImportError(sourcePath, `unrecognized snapshot for engine ${document.engineId}`);
  }

  // A bare session sidecar: { sessionId }.
  if (typeof document.sessionId === "string" && Object.keys(document).length === 1) {
    return {
      kind: "claude-sdk-session",
      path: sourcePath,
      document: { engineId: "claude-agent-sdk", data: { sessionId: document.sessionId } },
    };
  }

  throw new ImportError(sourcePath, "does not match any known session format");
}

/** What each source shape costs to bring across, and whether it can resume. */
function assess(source: LegacySource): {
  resumable: boolean;
  readOnly: boolean;
  losses: Loss[];
} {
  switch (source.kind) {
    case "claude-sdk-session": {
      // Only the id is ours. The transcript stays in the SDK's own file, which we
      // can read as prose but not as the typed exchange it was, so the session
      // resumes through the SDK and its history is not ours to replay.
      return {
        resumable: true,
        readOnly: true,
        losses: [
          {
            kind: "typed-tool-history",
            detail:
              "the transcript is owned by the Claude Agent SDK; tool calls and results are recoverable only as text",
          },
          {
            kind: "reasoning-continuity",
            detail: "reasoning signatures are not exposed by the SDK session file",
          },
          { kind: "turn-boundaries", detail: "turn boundaries are not recorded in the session id" },
          { kind: "usage-accounting", detail: "per-turn usage is not recoverable from the session id" },
        ],
      };
    }

    case "native-snapshot":
    case "hardened-native-snapshot": {
      // ProviderMessage content maps onto ContentPart member for member, so the
      // history survives verbatim inside the engine state. What it never had is
      // attachments and per-turn structure.
      const inner = (source.document as { data?: unknown }).data;
      const messages = isRecord(inner) && Array.isArray(inner.messages) ? inner.messages : [];
      const losses: Loss[] = [
        {
          kind: "turn-boundaries",
          detail: "the snapshot records a turn count, not where each turn began",
        },
        {
          kind: "attachments",
          detail: "images and file attachments are not represented in a provider message",
        },
      ];
      if (messages.length === 0) {
        losses.push({
          kind: "typed-tool-history",
          detail: "the snapshot carries no messages, so there is no history to resume into",
        });
      }
      return { resumable: messages.length > 0, readOnly: false, losses };
    }

    case "team-checkpoint": {
      // Not a conversation. It records which units of work finished, which is
      // worth keeping and is not a session — so it is archived under its own
      // name rather than converted into an empty one.
      return {
        resumable: false,
        readOnly: true,
        losses: [
          {
            kind: "typed-tool-history",
            detail: "a team checkpoint records unit outcomes, not conversation history",
          },
        ],
      };
    }
  }
}

/** Session id to import as, when the caller does not name one. */
function deriveSessionId(source: LegacySource): string {
  const doc = source.document as { data?: unknown; teamName?: unknown };
  if (source.kind === "claude-sdk-session" && isRecord(doc.data) && typeof doc.data.sessionId === "string") {
    return doc.data.sessionId;
  }
  if (source.kind === "team-checkpoint" && typeof doc.teamName === "string") {
    return `team-${doc.teamName}`;
  }
  return path.basename(source.path, path.extname(source.path));
}

/**
 * Copy a source before it is migrated.
 *
 * A failure here fails the import. A backup that silently did not happen is
 * indistinguishable from one that did until the moment it is needed.
 */
async function backup(sourcePath: string, backupDir: string, stamp: number): Promise<string> {
  const dir = path.join(backupDir, `${stamp}`);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(sourcePath));
  await fsp.copyFile(sourcePath, dest);
  return dest;
}

/**
 * Import one legacy source into `store`.
 *
 * Order is deliberate: back up, then write the verdict, then write the state. A
 * reader that finds a `SessionCreated` with no `EngineStateRecorded` after it
 * knows the import was interrupted, which is recoverable. The reverse order would
 * leave engine state with no provenance, which reads as a native session.
 */
export async function importSession(
  store: EventStore,
  source: LegacySource,
  options: ImportOptions,
): Promise<ImportOutcome> {
  const now = options.now ?? Date.now;
  const stamp = now();
  const sessionId = options.sessionId ?? deriveSessionId(source);
  const { resumable, readOnly, losses } = assess(source);

  const backupPath = await backup(source.path, options.backupDir, stamp);

  const provenance: ImportedSessionPayload = {
    origin: "import",
    sourceKind: source.kind,
    sourcePath: source.path,
    importedAt: stamp,
    resumable,
    readOnly,
    losses,
    backupPath,
  };

  await store.append({ sessionId, type: "SessionCreated", payload: provenance });
  let recordsWritten = 1;

  if (source.kind === "team-checkpoint") {
    // Archived rather than converted: it is real state that this journal has no
    // shape for, and dropping it silently is the failure this package exists to
    // stop. The archive sits beside the backup under its own name.
    const archiveDir = path.join(options.backupDir, `${stamp}`, "unsupported");
    await fsp.mkdir(archiveDir, { recursive: true });
    const archivedPath = path.join(archiveDir, path.basename(source.path));
    await fsp.copyFile(source.path, archivedPath);
    return { sessionId, source, resumable, readOnly, losses, backupPath, archivedPath, recordsWritten };
  }

  const engineState: EngineSessionState = {
    engineId: (source.document as { engineId: string }).engineId,
    data: (source.document as { data: unknown }).data,
  };
  await store.append({ sessionId, type: "EngineStateRecorded", payload: engineState });
  recordsWritten += 1;

  return { sessionId, source, resumable, readOnly, losses, backupPath, recordsWritten };
}

/**
 * Read back an imported session's verdict.
 *
 * The verdict has to be recoverable from the journal alone. Whoever resumes a
 * session months later is not the person who ran the migration and has no access
 * to what it printed.
 */
export async function readImportVerdict(
  store: EventStore,
  sessionId: string,
): Promise<ImportedSessionPayload | null> {
  for await (const record of store.read(sessionId)) {
    if (record.type !== "SessionCreated") continue;
    const payload = record.payload;
    if (isRecord(payload) && payload.origin === "import") {
      return payload as unknown as ImportedSessionPayload;
    }
    return null;
  }
  return null;
}
