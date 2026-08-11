/**
 * Durable kernel journal (docs/67 §A0, WP-00).
 *
 * The existing lane-event writers (session-recorder, team-daemon, ACP spine)
 * are `createWriteStream` appenders with no flush discipline. Measured under
 * `WP-07`, the gap is narrower than this comment first claimed but real: an
 * acknowledged write is past the syscall and survives a hard kill, while an
 * unacknowledged one is still in the stream's queue and is lost with the
 * process, and neither is on the disk until something syncs. Those writers do
 * not await, so their unacknowledged tail is unbounded. That is survivable for
 * a telemetry stream and not for an attempt journal, where "did this effect
 * already run?" has to be answerable after a hard kill — hence the explicit
 * commit below, which resolves only once the record is durable.
 *
 * This store therefore commits with an explicit fsync and defines committed
 * narrowly: a record is committed only when its line is complete and durable.
 * A torn trailing line is treated as never-committed and dropped on read, which
 * is the safe reading — the caller could not have received an acknowledgement
 * for it.
 *
 * Sequence numbers are gap-free per session, so a reader can tell a lost record
 * from an absent one instead of silently skipping it.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  KERNEL_SCHEMA_VERSION,
  isReadableSchema,
  type EventEnvelope,
  type KernelEventType,
} from "./contracts.js";

/** Fields the caller supplies; the store owns schema, seq, id, and timestamp. */
export interface NewEvent<T> {
  readonly sessionId: string;
  readonly type: KernelEventType;
  readonly payload: T;
  readonly causationId?: string;
}

export interface EventStore {
  /** Appends and does not resolve until the record is durable. */
  append<T>(event: NewEvent<T>): Promise<EventEnvelope<T>>;
  /** Committed records in sequence order. Torn trailing lines are skipped. */
  read(sessionId: string): AsyncIterable<EventEnvelope>;
  /** Highest committed sequence, or 0 for an empty/absent journal. */
  lastSeq(sessionId: string): Promise<number>;
  close(): Promise<void>;
}

/** Raised when a journal is damaged somewhere other than its final line. */
export class JournalCorruptError extends Error {
  constructor(
    readonly sessionId: string,
    readonly lineNumber: number,
    detail: string,
  ) {
    super(`journal for session ${sessionId} is corrupt at line ${lineNumber}: ${detail}`);
    this.name = "JournalCorruptError";
  }
}

interface SessionHandle {
  readonly file: fs.FileHandle;
  nextSeq: number;
  /** Serializes appends so sequence assignment cannot interleave. */
  tail: Promise<unknown>;
}

export class FileEventStore implements EventStore {
  private readonly handles = new Map<string, Promise<SessionHandle>>();

  constructor(private readonly rootDir: string) {}

  private journalPath(sessionId: string): string {
    return path.join(this.rootDir, sessionId, "journal.jsonl");
  }

  private async openSession(sessionId: string): Promise<SessionHandle> {
    const file = this.journalPath(sessionId);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });

    // Recover the sequence before taking the append handle, so a restart
    // continues the existing numbering rather than restarting it.
    const nextSeq = (await this.lastSeqFromDisk(sessionId)) + 1;
    const handle = await fs.open(file, "a");

    // A freshly created file is only durable once its parent directory entry
    // is synced; without this a crash can leave committed records in a file
    // the filesystem does not yet list.
    const dirHandle = await fs.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }

    return { file: handle, nextSeq, tail: Promise.resolve() };
  }

  private session(sessionId: string): Promise<SessionHandle> {
    let existing = this.handles.get(sessionId);
    if (!existing) {
      existing = this.openSession(sessionId);
      this.handles.set(sessionId, existing);
    }
    return existing;
  }

  async append<T>(event: NewEvent<T>): Promise<EventEnvelope<T>> {
    const session = await this.session(event.sessionId);

    // Chain onto the previous append so two concurrent callers cannot be
    // handed the same sequence number.
    const result = session.tail.then(async () => {
      const envelope: EventEnvelope<T> = {
        schema: KERNEL_SCHEMA_VERSION,
        seq: session.nextSeq,
        eventId: randomUUID(),
        sessionId: event.sessionId,
        ts: Date.now(),
        type: event.type,
        payload: event.payload,
        ...(event.causationId !== undefined && { causationId: event.causationId }),
      };

      const line = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
      // One write for the whole line: a partial write then reads back as an
      // incomplete trailing line, which is exactly the never-committed case.
      await session.file.write(line);
      await session.file.sync();

      session.nextSeq += 1;
      return envelope;
    });

    session.tail = result.catch(() => undefined);
    return result;
  }

  async lastSeq(sessionId: string): Promise<number> {
    const open = this.handles.get(sessionId);
    if (open) return (await open).nextSeq - 1;
    return this.lastSeqFromDisk(sessionId);
  }

  private async lastSeqFromDisk(sessionId: string): Promise<number> {
    let seq = 0;
    for await (const record of this.read(sessionId)) seq = record.seq;
    return seq;
  }

  async *read(sessionId: string): AsyncIterable<EventEnvelope> {
    let raw: string;
    try {
      raw = await fs.readFile(this.journalPath(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (raw === "") return;

    // A journal always ends in "\n" when the last append committed. Anything
    // after the final newline is a torn write from an interrupted append.
    const lastNewline = raw.lastIndexOf("\n");
    const complete = lastNewline === -1 ? "" : raw.slice(0, lastNewline);
    if (complete === "") return;

    const lines = complete.split("\n");
    let expectedSeq = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Mid-file damage is real corruption, not an interrupted append.
        throw new JournalCorruptError(sessionId, i + 1, "unparseable JSON");
      }

      const envelope = parsed as EventEnvelope;
      if (typeof envelope.seq !== "number" || typeof envelope.schema !== "number") {
        throw new JournalCorruptError(sessionId, i + 1, "missing seq or schema");
      }
      if (!isReadableSchema(envelope.schema)) {
        throw new JournalCorruptError(
          sessionId,
          i + 1,
          `schema ${envelope.schema} is outside the readable range`,
        );
      }
      if (envelope.seq !== expectedSeq) {
        throw new JournalCorruptError(
          sessionId,
          i + 1,
          `expected seq ${expectedSeq}, found ${envelope.seq}`,
        );
      }

      expectedSeq += 1;
      yield envelope;
    }
  }

  async close(): Promise<void> {
    const open = [...this.handles.values()];
    this.handles.clear();
    for (const pending of open) {
      try {
        const session = await pending;
        await session.tail.catch(() => undefined);
        await session.file.close();
      } catch {
        // A session that failed to open has nothing to release.
      }
    }
  }
}
