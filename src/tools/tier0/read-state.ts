/**
 * read-state — session-scoped tracking of which files the agent has read, and
 * what they contained when it read them.
 *
 * Claude Code (and MiMoCode) enforce a read-before-edit contract: Edit/Write
 * on an existing file fails with a recoverable error unless the file was
 * Read earlier in the session. Models trained on those harnesses expect the
 * contract and self-correct when they hit the error, so we enforce the same
 * rule here (docs/04-tool-tiers.md, "Claude Code schema alignment").
 *
 * The module also tracks read recency, mirroring Claude Code's
 * `readFileState`: after compaction the engine re-injects the most recently
 * read files as attachments (docs/48-compaction-design.md §L4).
 *
 * It records content identity as well as the path, and that half is what makes
 * the contract mean anything in a shared workspace (docs/63 `WP-11`). A record
 * of paths alone answers "has the agent read this?" and cannot answer "is this
 * still what the agent read?", so `hasFileBeenRead` returned true for a file
 * another agent had since replaced — and `write_file`, which never reads its
 * target, then overwrote that work and reported success. The two questions look
 * like one until several agents share a directory.
 *
 * State is process-global: each openswarm agent runs its tools in its own
 * process, so a module-level map is effectively session scope. Writes also
 * record state — after write_file/edit_file succeed the agent knows the
 * file's content, so requiring a re-read would only add noise.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";

interface ReadRecord {
  /** Monotonic recency counter (not wall-clock — cheap and total-ordered). */
  seq: number;
  /** SHA-256 of the bytes the agent saw, or null when they are unknown. */
  contentHash: string | null;
  /**
   * Cheap identity, used to answer "unchanged" without re-hashing. Refreshed
   * whenever a hash comparison proves the content is still the same, so a file
   * that was merely touched is not re-hashed on every subsequent write.
   */
  sizeBytes: number | null;
  mtimeMs: number | null;
}

const readPaths = new Map<string, ReadRecord>();
let seqCounter = 0;

/** Normalize to an absolute path so relative/absolute callers agree. */
function normalize(absPath: string): string {
  return path.resolve(absPath);
}

function hashOf(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Stat is done synchronously and deliberately. `recordFileRead` is a synchronous
 * call at six sites, and the alternative — stamping the identity from a promise
 * after returning — leaves a window where the record exists without the identity
 * that makes it useful, which is the same class of bug as not recording it at
 * all. One stat against a file the caller has just read is not worth a race.
 */
function statOf(file: string): { sizeBytes: number; mtimeMs: number } | null {
  try {
    const st = fss.statSync(file);
    return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Record that a file's current content is known to the agent.
 *
 * `content` is optional only because not every caller has the bytes to hand;
 * pass it whenever they are already in memory, which is the case at every tool
 * call site. Without it the record still carries the path and recency, so the
 * read-before-edit contract holds, but staleness cannot be judged — the record
 * says so rather than guessing.
 */
export function recordFileRead(absPath: string, content?: string): void {
  const file = normalize(absPath);
  const st = statOf(file);
  readPaths.set(file, {
    seq: ++seqCounter,
    contentHash: content !== undefined ? hashOf(content) : null,
    sizeBytes: st?.sizeBytes ?? null,
    mtimeMs: st?.mtimeMs ?? null,
  });
}

/** True when the file was read (or written) earlier in this session. */
export function hasFileBeenRead(absPath: string): boolean {
  return readPaths.has(normalize(absPath));
}

/** What the agent knows about a path, relative to what is on disk now. */
export type ReadVerdict =
  /** Never read in this session — the read-before-edit contract's own case. */
  | { readonly kind: "never-read" }
  /** Read, and the bytes on disk are still the bytes the agent saw. */
  | { readonly kind: "current" }
  /** Read, but somebody has changed it since. */
  | { readonly kind: "stale"; readonly detail: string }
  /**
   * Read, and nothing is recorded about the content, so staleness is not
   * decidable. Treated as current by callers: refusing every write on a path
   * whose bytes were never captured would break the contract rather than
   * enforce it.
   */
  | { readonly kind: "unknown" };

/**
 * Whether the file still holds what the agent read.
 *
 * Size and mtime are consulted first, and a match ends it. When they differ the
 * bytes are hashed, because a file rewritten with identical content is not
 * stale in any sense the agent cares about — and because tools that write
 * through a temp file and rename change mtime on every save.
 */
export async function checkFileCurrent(absPath: string): Promise<ReadVerdict> {
  const file = normalize(absPath);
  const record = readPaths.get(file);
  if (record === undefined) return { kind: "never-read" };
  if (record.contentHash === null) return { kind: "unknown" };

  const st = statOf(file);
  if (st === null) {
    return { kind: "stale", detail: "the file no longer exists" };
  }

  if (
    record.sizeBytes !== null &&
    record.mtimeMs !== null &&
    st.sizeBytes === record.sizeBytes &&
    st.mtimeMs === record.mtimeMs
  ) {
    return { kind: "current" };
  }

  let current: string;
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    return { kind: "stale", detail: "the file could not be read back" };
  }

  if (hashOf(current) === record.contentHash) {
    // Same bytes under a new mtime. Remember that, so the next check is cheap.
    record.sizeBytes = st.sizeBytes;
    record.mtimeMs = st.mtimeMs;
    return { kind: "current" };
  }

  return {
    kind: "stale",
    detail:
      record.sizeBytes !== null && st.sizeBytes !== record.sizeBytes
        ? `it is now ${st.sizeBytes} bytes, was ${record.sizeBytes}`
        : "its contents differ from what was read",
  };
}

/** The hash the agent last saw for this path, when one was recorded. */
export function recordedHash(absPath: string): string | null {
  return readPaths.get(normalize(absPath))?.contentHash ?? null;
}

/**
 * The most recently read/written file paths, newest first — Claude Code's
 * post-compact file re-injection source (`readFileState`, top 5 by recency).
 */
export function recentReadFiles(limit: number): string[] {
  return [...readPaths.entries()]
    .sort((a, b) => b[1].seq - a[1].seq)
    .slice(0, limit)
    .map(([p]) => p);
}

/**
 * The Claude Code error string for read-before-edit violations. Trained
 * models recognize this exact phrasing and respond by reading the file.
 */
export const READ_BEFORE_EDIT_ERROR =
  "File has not been read yet. Read it first before writing to it.";

/** Reset all read state (test isolation; also cleared at compaction). */
export function clearReadState(): void {
  readPaths.clear();
}
