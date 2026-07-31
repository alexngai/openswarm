/**
 * Checksummed atomic snapshots (docs/63 `WP-07`).
 *
 * Snapshots in the tree were written three different ways with three different
 * guarantees. Team checkpoints and engine snapshots wrote to a temp file and
 * renamed, which is atomic against a reader but says nothing about whether the
 * bytes reached disk before the rename did. The daemon's `state.json` and the
 * session sidecar were written straight over the live file, so a crash mid-write
 * left a half-written document that a reader would happily open — and since both
 * are JSON, "half-written" usually means truncated at an arbitrary byte, which
 * parses as a syntax error at best and as a valid-but-wrong shorter document at
 * worst.
 *
 * Neither shape had a checksum. A rename is atomic with respect to *this*
 * writer; it is not a statement about the file's integrity, and a snapshot
 * damaged by anything other than an interrupted write — a full disk that
 * silently truncated, a partially-restored backup, a bad sector — reads back as
 * plausible data. The failure mode of a snapshot is not "it throws"; it is that
 * the system resumes from a state that never existed.
 *
 * So: content is wrapped with a digest of itself, and the write is temp file →
 * fsync the data → rename → fsync the directory. The last step is the one that
 * is usually skipped and the reason a rename can be lost while the data it
 * pointed at survives.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Bumped only if this envelope's own shape changes, not the payload's. */
const SNAPSHOT_ENVELOPE_VERSION = 1;

interface SnapshotEnvelope {
  readonly envelope: number;
  /** SHA-256 of the canonical JSON of `data`. */
  readonly checksum: string;
  readonly writtenAt: number;
  readonly data: unknown;
}

export type SnapshotRead<T> =
  | { readonly kind: "ok"; readonly data: T; readonly writtenAt: number }
  | { readonly kind: "absent" }
  /**
   * Present and unusable. Distinguished from absent because they call for
   * opposite responses: a missing snapshot means start fresh, while a corrupt one
   * means something went wrong that someone should hear about — and treating the
   * second as the first is how a silent data loss becomes a clean-looking start.
   */
  | { readonly kind: "corrupt"; readonly reason: string };

function digest(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data) ?? "null").digest("hex");
}

/**
 * Write `data` so that a reader sees either the previous snapshot or this one,
 * never a mixture, and so that a crash after the rename cannot lose the bytes.
 */
export async function writeSnapshot(filePath: string, data: unknown): Promise<void> {
  const envelope: SnapshotEnvelope = {
    envelope: SNAPSHOT_ENVELOPE_VERSION,
    checksum: digest(data),
    writtenAt: Date.now(),
    data,
  };

  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  // Unique per call, not per process-and-millisecond: two writers in one tick
  // would otherwise pick the same temp name, and the first rename to win would
  // pull the file out from under the second, which then fails with ENOENT on a
  // path it created itself.
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${randomUUID()}`);

  const handle = await fsp.open(tmp, "w");
  try {
    await handle.write(Buffer.from(JSON.stringify(envelope) + "\n", "utf8"));
    // Before the rename, not after: a rename that lands while the data is still
    // in the page cache publishes a name pointing at nothing in particular.
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }

  await fsp.rename(tmp, filePath);

  // The rename itself is metadata, and metadata is buffered too. Without this a
  // crash can leave the old snapshot in place with the new one's data orphaned.
  const dirHandle = await fsp.open(dir, "r").catch(() => null);
  if (dirHandle !== null) {
    await dirHandle.sync().catch(() => {});
    await dirHandle.close().catch(() => {});
  }
}

/**
 * Read a snapshot back, verifying it is the document that was written.
 *
 * `validate` is applied after the checksum passes, so a snapshot that is intact
 * but of the wrong shape — an older schema, a file from a different tool — is
 * reported as corrupt rather than handed over as the caller's type.
 */
export async function readSnapshot<T>(
  filePath: string,
  validate?: (data: unknown) => data is T,
): Promise<SnapshotRead<T>> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt", reason: `unreadable: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "corrupt", reason: `not JSON: ${(err as Error).message}` };
  }

  const env = parsed as Partial<SnapshotEnvelope>;
  if (typeof env?.checksum !== "string" || !("data" in (env as object))) {
    return { kind: "corrupt", reason: "not a checksummed snapshot" };
  }
  if (env.envelope !== SNAPSHOT_ENVELOPE_VERSION) {
    return { kind: "corrupt", reason: `unknown envelope version ${String(env.envelope)}` };
  }
  if (digest(env.data) !== env.checksum) {
    return { kind: "corrupt", reason: "checksum mismatch" };
  }
  if (validate !== undefined && !validate(env.data)) {
    return { kind: "corrupt", reason: "payload failed validation" };
  }

  return { kind: "ok", data: env.data as T, writtenAt: env.writtenAt ?? 0 };
}
