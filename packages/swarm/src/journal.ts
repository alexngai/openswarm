/**
 * SwarmJournal — a run's append-only JSONL journal (docs/05 §5.2, D1).
 *
 * Board and mailbox state lives here, not in the lead's dsh session log: dsh
 * refuses to reload a session holding plugin event types (docs/05 §11), so a
 * session that hosted a board could never resume. One writer per journal —
 * the run's lead, which takes that role by opening it; there is no
 * cross-process locking. Each open mints a fresh `incarnation`, which board
 * leases record, so a later opener can tell a dead lead's claims from its own.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, truncateSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Serializer } from './serialize'

export interface SwarmJournalEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

/** The file's complete lines as events, where they end, and its size; a missing file is empty. */
function load(path: string): { events: SwarmJournalEvent[]; end: number; size: number } {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { events: [], end: 0, size: 0 }
  }
  const end = bytes.lastIndexOf(0x0a) + 1
  const lines = bytes.subarray(0, end).toString('utf8').split('\n')
  return {
    events: lines.filter((line) => line !== '').map((line) => JSON.parse(line) as SwarmJournalEvent),
    end,
    size: bytes.length,
  }
}

export class SwarmJournal {
  /** Identifies this open; a claim whose lease differs was granted by another. */
  readonly incarnation = randomUUID()
  private readonly writes = new Serializer()
  private readonly waiters = new Set<() => void>()
  private nextSeq: number

  private constructor(
    readonly path: string,
    /** Events durably appended so far, in seq order. */
    readonly events: SwarmJournalEvent[],
  ) {
    this.nextSeq = (events.at(-1)?.seq ?? -1) + 1
  }

  static open(path: string): SwarmJournal {
    mkdirSync(dirname(path), { recursive: true })
    const { events, end, size } = load(path)
    // Every append ends in '\n', so bytes after the last one are a torn write
    // from a crashed writer whose append never resolved. Cut them off so the
    // next append starts a clean line.
    if (end < size) truncateSync(path, end)
    return new SwarmJournal(path, events)
  }

  /**
   * The complete events at `path` without taking the writer role: nothing is
   * created or truncated, so a reader never cuts a live writer's line short.
   */
  static read(path: string): SwarmJournalEvent[] {
    return load(path).events
  }

  /** Append one event; resolves once the line is written to the file. */
  append(type: string, data: unknown): Promise<SwarmJournalEvent> {
    const event: SwarmJournalEvent = { seq: this.nextSeq++, time: Date.now(), type, data }
    // Board and mailbox share one journal with separate transaction tails, so
    // writes are ordered here to keep file order equal to seq order.
    return this.writes.run(async () => {
      // ponytail: appendFile survives a process crash, not power loss; fsync per append if hosts can lose power mid-run.
      await appendFile(this.path, `${JSON.stringify(event)}\n`)
      this.events.push(event)
      for (const wake of [...this.waiters]) wake()
      return event
    })
  }

  /**
   * Resolve once an event past `afterSeq` exists: at once if one already
   * does, else on the next append or after `timeoutMs`, whichever is first.
   */
  waitForAppend(afterSeq: number, timeoutMs: number): Promise<void> {
    if ((this.events.at(-1)?.seq ?? -1) > afterSeq) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      // A long-poll must never hold the process open.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      this.waiters.add(wake)
    })
  }
}
