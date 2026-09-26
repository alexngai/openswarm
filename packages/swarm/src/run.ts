/**
 * The run record and recap over a run's journal (docs/05 §5.1, A4).
 *
 * A run's lifecycle is a whole-snapshot `swarm/run` event, folded like board
 * tasks (last wins): `running` at start, then `finished` or `failed` when its
 * result settles, or `interrupted` when `attach` takes over from a dead writer.
 */
import type { MergeOutcome } from 'openswarm-git'
import type { SwarmTaskSnapshot } from './board'
import type { SwarmJournalEvent } from './journal'
import type { SwarmMessageSnapshot } from './mailbox'
import type { TeamResult, TeamSpec } from './types'

export type SwarmRunStatus = 'running' | 'finished' | 'failed' | 'interrupted'

/** Whole durable run value; the latest `swarm/run` event wins. */
export interface SwarmRunRecord {
  readonly id: string
  readonly status: SwarmRunStatus
  readonly topology: TeamSpec['topology']
  readonly parentSessionId: string
  /** The process appending to the journal; its claims carry `incarnation` as their lease. */
  readonly writer: { readonly pid: number; readonly host: string; readonly incarnation: string }
  readonly startedAt: number
  readonly endedAt?: number
  readonly error?: string
  readonly result?: TeamResult & { git?: MergeOutcome }
  readonly spec?: TeamSpec
}

/** Payload of a `swarm/run` journal event. */
export type SwarmRunEvent = { version: 1; run: SwarmRunRecord }

/** A run as its journal records it. */
export interface SwarmRunView {
  run: SwarmRunRecord
  tasks: SwarmTaskSnapshot[]
  /** {@link recapJournal} lines. */
  recap: string[]
}

/** The run's current record, or undefined when the journal holds none. */
export function foldRun(events: ReadonlyArray<{ type: string; data?: unknown }>): SwarmRunRecord | undefined {
  let run: SwarmRunRecord | undefined
  for (const event of events) if (event.type === 'swarm/run') run = (event.data as SwarmRunEvent).run
  return run
}

/**
 * One human-readable line per journal event with seq > `since`, prefixed with
 * that seq so a reader can pass the last one back as its next cursor.
 */
export function recapJournal(events: readonly SwarmJournalEvent[], since = -1): string[] {
  const tasks = new Map<string, SwarmTaskSnapshot>()
  const messages = new Map<string, SwarmMessageSnapshot>()
  const lines: string[] = []
  for (const { seq, type, data } of events) {
    let line: string | undefined
    if (type === 'swarm/task') {
      const { task } = data as { task: SwarmTaskSnapshot }
      const before = tasks.get(task.id)
      tasks.set(task.id, task)
      if (task.status === 'in_progress') line = `${task.id} claimed by ${task.owner}`
      else if (task.status === 'completed') {
        const head = task.result === undefined ? '' : `: ${task.result.split('\n')[0]!.slice(0, 80)}`
        line = `${task.id} completed by ${task.owner}${head}`
      } else if (before === undefined) line = `${task.id} created: ${task.subject}`
      else line = `${task.id} released (was ${before.owner})`
    } else if (type === 'swarm/message/queued') {
      const { message } = data as { message: SwarmMessageSnapshot }
      messages.set(message.id, message)
      line = `message ${message.from}→${message.to} queued (${message.delivery})`
    } else if (type === 'swarm/message/delivered') {
      const { messageId } = data as { messageId: string }
      const message = messages.get(messageId)
      line = `message ${message === undefined ? messageId : `${message.from}→${message.to}`} delivered`
    } else if (type === 'swarm/run') {
      const { run } = data as SwarmRunEvent
      const where = `pid ${run.writer.pid} on ${run.writer.host}`
      if (run.status === 'running') line = `run started: ${run.topology} (${where})`
      else if (run.status === 'failed') line = `run failed: ${run.error}`
      else if (run.status === 'interrupted') line = `run interrupted; taken over by ${where}`
      else line = 'run finished'
    }
    if (line !== undefined && seq > since) lines.push(`#${seq} ${line}`)
  }
  return lines
}
