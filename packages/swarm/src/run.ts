/**
 * The run record and recap over a run's journal (docs/05 §5.1, A4).
 *
 * A run's lifecycle is a whole-snapshot `swarm/run` event, folded like board
 * tasks (last wins): `running` at start, then `finished` or `failed` when its
 * result settles, or `interrupted` when `attach` takes over from a dead writer.
 * Questions the harness raises (A6) are folded the same way, per question id.
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

/** Payload of a `swarm/steer` journal event: a steer as it was delivered (docs/05 §6.1). */
export type SwarmSteerEvent = {
  version: 1
  to: string
  text: string
  /** `immediate` at the member's next step boundary, `enqueue` as its next turn. */
  delivery: 'immediate' | 'enqueue'
  by: string
}

/**
 * A harness-raised question (docs/05 §6.1), whole snapshot: the latest
 * `swarm/question` event per id wins.
 */
export interface SwarmQuestion {
  /** `q-<n>`, unique within its run. */
  readonly id: string
  readonly trigger: 'stall' | 'restart-budget' | 'task-attempts' | 'verifier-failure'
  readonly kind: 'escalation' | 'consent' | 'approval'
  /** An owner answers any tier; a driver only `low`, and never a consent or approval (§5.3). */
  readonly tier: 'low' | 'high'
  readonly prompt: string
  readonly options: readonly string[]
  /** Taken on timeout, past the open-question cap, or when the run ends. */
  readonly default: string
  readonly status: 'open' | 'answered' | 'defaulted' | 'capped'
  readonly answer?: string
  /** The answering principal's role, or `userQuestions` for dsh's web prompt. */
  readonly by?: string
  readonly raisedAt: number
  readonly closedAt?: number
}

/** Payload of a `swarm/question` journal event. */
export type SwarmQuestionEvent = { version: 1; question: SwarmQuestion }

/** What a trigger asks; unless it says otherwise, a low-tier escalation. */
export type SwarmQuestionRequest = Pick<SwarmQuestion, 'trigger' | 'prompt' | 'options' | 'default'> &
  Partial<Pick<SwarmQuestion, 'kind' | 'tier'>>

/** Raise a question and resolve its answer, one of its options. */
export type AskQuestion = (question: SwarmQuestionRequest) => Promise<string>

/** A run as its journal records it. */
export interface SwarmRunView {
  run: SwarmRunRecord
  tasks: SwarmTaskSnapshot[]
  questions: SwarmQuestion[]
  /** {@link recapJournal} lines. */
  recap: string[]
}

/**
 * A settled run's deliverable as text: the synthesis or final output where
 * the topology has one, else each member's output under its label.
 */
export function resultText(result: TeamResult): string {
  const one = 'synthesis' in result ? result.synthesis : 'final' in result ? result.final : undefined
  if (one !== undefined) return one.text
  const parts: [string, string][] =
    result.topology === 'peer-team'
      ? result.tasks.map((t) => [`${t.id} ${t.subject}`, t.result ?? ''])
      : (result.topology === 'fanout' ? result.results : 'answers' in result ? result.answers : []).map((r) => [r.member, r.text])
  return parts.map(([label, text]) => `--- ${label} ---\n${text}`).join('\n\n')
}

/** The run's current record, or undefined when the journal holds none. */
export function foldRun(events: ReadonlyArray<{ type: string; data?: unknown }>): SwarmRunRecord | undefined {
  let run: SwarmRunRecord | undefined
  for (const event of events) if (event.type === 'swarm/run') run = (event.data as SwarmRunEvent).run
  return run
}

/** Every question the journal records, oldest first, each as its latest snapshot. */
export function foldQuestions(events: ReadonlyArray<{ type: string; data?: unknown }>): Map<string, SwarmQuestion> {
  const questions = new Map<string, SwarmQuestion>()
  for (const event of events) {
    if (event.type !== 'swarm/question') continue
    const { question } = event.data as SwarmQuestionEvent
    questions.set(question.id, question)
  }
  return questions
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
    } else if (type === 'swarm/steer') {
      const { by, to, delivery, text } = data as SwarmSteerEvent
      line = `steer ${by}→${to} (${delivery}): ${text.split('\n')[0]!.slice(0, 80)}`
    } else if (type === 'swarm/question') {
      const { question: q } = data as SwarmQuestionEvent
      if (q.status === 'open') line = `${q.id} raised (${q.trigger}): ${q.prompt.split('\n')[0]!.slice(0, 80)}`
      else if (q.status === 'answered') line = `${q.id} answered by ${q.by}: ${q.answer}`
      else if (q.status === 'defaulted') line = `${q.id} defaulted to ${q.answer}`
      else line = `${q.id} capped (${q.trigger}): defaulted to ${q.answer}`
    } else if (type === 'swarm/run') {
      const { run } = data as SwarmRunEvent
      const where = `pid ${run.writer.pid} on ${run.writer.host}`
      const purpose = run.spec?.intent === undefined ? '' : `: ${run.spec.intent.purpose.split('\n')[0]!.slice(0, 80)}`
      if (run.status === 'running') line = `run started: ${run.topology} (${where})${purpose}`
      else if (run.status === 'failed') line = `run failed: ${run.error}`
      else if (run.status === 'interrupted') line = `run interrupted; taken over by ${where}`
      else line = 'run finished'
    }
    if (line !== undefined && seq > since) lines.push(`#${seq} ${line}`)
  }
  return lines
}
