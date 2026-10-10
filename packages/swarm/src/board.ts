/**
 * SwarmBoard — the durable shared task board (docs/01 F1).
 *
 * Every mutation appends a whole-snapshot `swarm/task` event to the run's
 * journal (docs/05 A3) and resolves once it is written; reads fold the
 * journal. Recovery is therefore replay: any process that opens the journal
 * sees the same board. Mutations are serialized per board through a
 * promise-chain tail (the agent-team journal pattern), and every mutation
 * carries an `expectedRevision` compare-and-set so stale writers fail loud
 * instead of overwriting newer state. A claim carries a lease — the journal
 * incarnation that granted it — so a later opener can release a dead lead's
 * claims ({@link SwarmBoard.releaseOrphans}). A board for a gated run refuses
 * to complete a task without passing evidence (docs/05 B6, exit criterion 4),
 * or with evidence below the task's verifier level (B1).
 */
import type { TamperSignal, VerifierLevel } from './gate'
import type { SwarmJournal } from './journal'
import type { Intent } from './types'
import { Serializer } from './serialize'

/** `pending` is unstarted or released; `in_progress` carries an owner. */
export type SwarmTaskStatus = 'pending' | 'in_progress' | 'completed'

/** Whole durable task value; every mutation increments {@link revision}. */
export interface SwarmTaskSnapshot {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly prompt: string
  readonly status: SwarmTaskStatus
  readonly owner?: string
  /** Task ids that must complete before this task is ready. */
  readonly blockedBy: readonly string[]
  /** Completion note recorded by the finishing owner. */
  readonly result?: string
  /** Journal incarnation that granted the current claim; set while `in_progress`. */
  readonly lease?: string
  /** The task's own intent; it replaces the run's for this task (docs/05 §6.1). */
  readonly intent?: Intent
  /** The task's own gate checks; they replace the team's (docs/05 B6b). */
  readonly checks?: readonly string[]
  /** The task's own verifier level and hidden suite; they replace the team's (docs/05 B1). */
  readonly minLevel?: VerifierLevel
  readonly suite?: string
  /** What closed it, when it closed through the gate or a human waived it. */
  readonly evidence?: TaskEvidence
}

/**
 * What a completed task closed on (docs/05 B6): the gate round that passed,
 * or a human who accepted it without (P8: only a human principal waives the
 * gate). The precursor of B0's `verifies` edge.
 */
export interface TaskEvidence {
  readonly kind: 'commands' | 'review' | 'hidden' | 'human'
  readonly passed: boolean
  /** The verifier level (docs/05 §6.4); none for a human waiver, and missing reads as L0. */
  readonly level?: VerifierLevel
  /** The gate round whose evidence this is. */
  readonly round?: number
  /** Review: the reviewer's 0–100 estimate; null when its verdict did not parse. */
  readonly score?: number | null
  /** Review: each target's status, with what an unverifiable one could not run. */
  readonly targets?: readonly { target: number; status: string; notes?: string }[]
  readonly failedCommands?: readonly string[]
  /** Hidden: the suite and its counts. */
  readonly suite?: string
  readonly total?: number
  readonly failed?: number
  /** Hidden: how the run was confined; a `partial` L3 (the operator allowed it) counts as L2 here. */
  readonly enforcement?: 'full' | 'partial'
  /**
   * The snapshot commit of the tree the evidence is about. ponytail: no ref
   * points at it, so `git gc` may prune it once old enough; B0's `verifies`
   * edge must pin it (a ref, or the landed commit) to stay checkable.
   */
  readonly snapshot?: string
  /** Human: who accepted it. */
  readonly by?: string
}

/** `L2 commands, round 2`, or `human: owner`: a task's evidence in a few words. */
export function evidenceText(evidence: TaskEvidence): string {
  if (evidence.kind === 'human') return `human: ${evidence.by}`
  const partial = evidence.enforcement === 'partial' ? ' (partial: counts as L2)' : ''
  return `L${evidence.level ?? 0} ${evidence.kind}${partial}, round ${evidence.round}`
}

/** The level evidence counts as: its own, but L2 for an L3 run the verifier could only partly confine. */
export function effectiveLevel(evidence: TaskEvidence): VerifierLevel {
  return evidence.level === 3 && evidence.enforcement === 'partial' ? 2 : (evidence.level ?? 0)
}

/** Payload of a `swarm/task` journal event. */
type SwarmTaskEvent = { version: 1; task: SwarmTaskSnapshot }

/** Payload of a `swarm/gate` journal event: one gate round on a board task, as the member was told it. */
export type SwarmGateEvent = {
  version: 1
  taskId: string
  member: string
  round: number
  /** False past round 1: the member stopped changing the tree, so the gate stopped. */
  changed: boolean
  kind: 'commands' | 'review' | 'hidden'
  /** The verifier level; absent in journals written before docs/05 B1. */
  level?: 1 | 2 | 3
  passed: boolean
  score?: number | null
  targets?: { target: number; status: string; notes?: string }[]
  failedCommands?: string[]
  /** The round broke a check the round before passed, and was undone. */
  rolledBack?: boolean
  /** Why the review or the hidden suite could not run. */
  error?: string
  /** Hidden: the suite, its counts, how its run was confined. */
  suite?: string
  total?: number
  failed?: number
  enforcement?: 'full' | 'partial'
  /** Hidden: the round was a tamper incident (its signals are the `swarm/tamper` event). */
  tamper?: true
  /** Hidden: the member's snapshot was refused, and why. */
  refused?: string
  /** Under L3: what the weaker source said, which the member was told too. */
  feedback?: { kind: 'commands' | 'review'; level: 1 | 2; passed: boolean; score?: number | null; failedCommands?: string[] }
  /** The snapshot commit of the tree the round left: what its evidence is about. */
  snapshot?: string
}

/**
 * Payload of a `swarm/tamper` journal event (docs/05 §6.4): signs that a
 * member reached for the hidden suite in a gate round. What matched, never
 * the content. An `incident` stopped the gate unmeasured; `advisory` signs
 * (bare mentions of the verifier) were recorded and the round measured.
 */
export type SwarmTamperEvent = {
  version: 1
  taskId: string
  member: string
  round: number
  suite: string
  severity: 'incident' | 'advisory'
  signals: TamperSignal[]
}

export type SwarmBoardErrorCode =
  | 'SWARM_TASK_NOT_FOUND'
  | 'SWARM_TASK_STALE_REVISION'
  | 'SWARM_TASK_NOT_READY'
  | 'SWARM_TASK_WRONG_OWNER'
  | 'SWARM_TASK_UNKNOWN_BLOCKER'
  | 'SWARM_TASK_UNVERIFIED'

export class SwarmBoardError extends Error {
  constructor(
    message: string,
    readonly code: SwarmBoardErrorCode,
  ) {
    super(message)
    this.name = 'SwarmBoardError'
  }
}

/**
 * Replay the journal into current task state, in creation order: an update
 * keeps a task's place (Map.set on a known key does), so the order is the
 * seed order the train takes as priority and claims follow, never the order
 * tasks last changed in.
 */
export function foldBoard(events: ReadonlyArray<{ type: string; data?: unknown }>): Map<string, SwarmTaskSnapshot> {
  const tasks = new Map<string, SwarmTaskSnapshot>()
  for (const event of events) {
    if (event.type !== 'swarm/task') continue
    const { task } = event.data as SwarmTaskEvent
    tasks.set(task.id, task)
  }
  return tasks
}

export class SwarmBoard {
  private readonly serial = new Serializer()
  private readonly waiters = new Set<() => void>()
  private nextTaskNumber = 0

  constructor(
    private readonly journal: SwarmJournal,
    /**
     * `gated`: `complete` requires passing evidence, so no path closes a task
     * unverified; at `minLevel` or above, unless the task says its own.
     */
    private readonly options: { gated?: boolean; minLevel?: VerifierLevel } = {},
  ) {}

  /** Current folded state (read-only; not serialized against mutations). */
  list(): SwarmTaskSnapshot[] {
    return [...this.fold().values()]
  }

  private fold(): Map<string, SwarmTaskSnapshot> {
    return foldBoard(this.journal.events)
  }

  private ready(task: SwarmTaskSnapshot, state: Map<string, SwarmTaskSnapshot>): boolean {
    return (
      task.status === 'pending' &&
      task.blockedBy.every((id) => state.get(id)?.status === 'completed')
    )
  }

  /** Serialize one read-check-append mutation against every other mutation. */
  private transact<T>(operation: () => Promise<T>): Promise<T> {
    return this.serial.run(operation)
  }

  private async commit(task: SwarmTaskSnapshot): Promise<SwarmTaskSnapshot> {
    await this.journal.append('swarm/task', { version: 1, task } satisfies SwarmTaskEvent)
    // Wake anyone parked in waitForChange: this commit may have unblocked a
    // dependent task or freed a claim.
    for (const wake of [...this.waiters]) wake()
    return task
  }

  /**
   * Resolve on the next committed mutation, or after `timeoutMs`.
   *
   * Replaces a 10ms spin in the board-worker loop: workers with nothing ready
   * are waiting on a sibling's commit, which is an event we already have. The
   * timeout is a backstop, not the mechanism — a worker must also re-check
   * conditions that no commit announces (an aborted sibling, a disposed run),
   * so parking forever on the event alone could hang the loop.
   */
  waitForChange(timeoutMs = 250): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      // Never hold the process open for a backstop poll.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      this.waiters.add(wake)
    })
  }

  private expect(
    state: Map<string, SwarmTaskSnapshot>,
    id: string,
    expectedRevision: number,
  ): SwarmTaskSnapshot {
    const task = state.get(id)
    if (task === undefined) throw new SwarmBoardError(`task "${id}" not found`, 'SWARM_TASK_NOT_FOUND')
    if (task.revision !== expectedRevision) {
      throw new SwarmBoardError(
        `task "${id}" is at revision ${task.revision}, not ${expectedRevision}`,
        'SWARM_TASK_STALE_REVISION',
      )
    }
    return task
  }

  create(input: {
    subject: string
    prompt: string
    blockedBy?: readonly string[]
    intent?: Intent
    checks?: readonly string[]
    minLevel?: VerifierLevel
    suite?: string
  }): Promise<SwarmTaskSnapshot> {
    return this.transact(async () => {
      const state = this.fold()
      const blockedBy = input.blockedBy ?? []
      for (const blocker of blockedBy) {
        if (!state.has(blocker)) {
          throw new SwarmBoardError(`unknown blocker "${blocker}"`, 'SWARM_TASK_UNKNOWN_BLOCKER')
        }
      }
      // Monotonic across the folded log so replays never reuse an id.
      for (const id of state.keys()) {
        const n = Number(id.replace('task-', ''))
        if (Number.isInteger(n) && n >= this.nextTaskNumber) this.nextTaskNumber = n + 1
      }
      const task: SwarmTaskSnapshot = {
        id: `task-${this.nextTaskNumber++}`,
        revision: 0,
        subject: input.subject,
        prompt: input.prompt,
        status: 'pending',
        blockedBy: [...blockedBy],
        ...(input.intent === undefined ? {} : { intent: input.intent }),
        ...(input.checks === undefined ? {} : { checks: [...input.checks] }),
        ...(input.minLevel === undefined ? {} : { minLevel: input.minLevel }),
        ...(input.suite === undefined ? {} : { suite: input.suite }),
      }
      return this.commit(task)
    })
  }

  claim(id: string, owner: string, expectedRevision: number): Promise<SwarmTaskSnapshot> {
    return this.transact(async () => {
      const state = this.fold()
      const task = this.expect(state, id, expectedRevision)
      if (!this.ready(task, state)) {
        throw new SwarmBoardError(`task "${id}" is not ready to claim`, 'SWARM_TASK_NOT_READY')
      }
      return this.commit({
        ...task,
        revision: task.revision + 1,
        status: 'in_progress',
        owner,
        lease: this.journal.incarnation,
      })
    })
  }

  complete(
    id: string,
    owner: string,
    expectedRevision: number,
    result?: string,
    evidence?: TaskEvidence,
  ): Promise<SwarmTaskSnapshot> {
    return this.transact(async () => {
      const task = this.expect(this.fold(), id, expectedRevision)
      if (task.owner !== owner) {
        throw new SwarmBoardError(`task "${id}" is owned by "${task.owner}"`, 'SWARM_TASK_WRONG_OWNER')
      }
      // A human waiver must name who gave it (P8); otherwise it is no evidence.
      if (this.options.gated === true && (evidence?.passed !== true || (evidence.kind === 'human' && !evidence.by))) {
        throw new SwarmBoardError(`task "${id}" is gated: it completes only with passing evidence`, 'SWARM_TASK_UNVERIFIED')
      }
      // Nor with a weaker verifier than it declared; a waiver is not a verifier, so has no level to fall short.
      const minLevel = task.minLevel ?? this.options.minLevel ?? 0
      const level = evidence === undefined ? 0 : effectiveLevel(evidence)
      if (this.options.gated === true && evidence?.kind !== 'human' && level < minLevel) {
        throw new SwarmBoardError(`task "${id}" needs L${minLevel} evidence; this counts as L${level}`, 'SWARM_TASK_UNVERIFIED')
      }
      const { lease: _lease, ...rest } = task
      return this.commit({
        ...rest,
        revision: task.revision + 1,
        status: 'completed',
        ...(result === undefined ? {} : { result }),
        ...(evidence === undefined ? {} : { evidence }),
      })
    })
  }

  /** Journal one gate round on a task (`swarm/gate`), so a recap shows what its member was told. */
  async recordGate(event: Omit<SwarmGateEvent, 'version'>): Promise<void> {
    await this.journal.append('swarm/gate', { version: 1, ...event } satisfies SwarmGateEvent)
  }

  /** Journal a tamper incident in a gate round (`swarm/tamper`). */
  async recordTamper(event: Omit<SwarmTamperEvent, 'version'>): Promise<void> {
    await this.journal.append('swarm/tamper', { version: 1, ...event } satisfies SwarmTamperEvent)
  }

  release(id: string, owner: string, expectedRevision: number): Promise<SwarmTaskSnapshot> {
    return this.transact(async () => {
      const task = this.expect(this.fold(), id, expectedRevision)
      if (task.owner !== owner) {
        throw new SwarmBoardError(`task "${id}" is owned by "${task.owner}"`, 'SWARM_TASK_WRONG_OWNER')
      }
      const { owner: _owner, lease: _lease, ...rest } = task
      return this.commit({ ...rest, revision: task.revision + 1, status: 'pending' })
    })
  }

  /**
   * Release every `in_progress` claim whose lease is not this journal
   * incarnation — claims granted by a lead process that has since died — back
   * to pending, one appended snapshot each so the release is auditable.
   * Not called automatically: A4's `attach` calls it when a new process takes
   * over a run's journal.
   */
  releaseOrphans(): Promise<SwarmTaskSnapshot[]> {
    return this.transact(async () => {
      const released: SwarmTaskSnapshot[] = []
      for (const task of this.fold().values()) {
        if (task.status !== 'in_progress' || task.lease === this.journal.incarnation) continue
        const { owner: _owner, lease: _lease, ...rest } = task
        released.push(await this.commit({ ...rest, revision: task.revision + 1, status: 'pending' }))
      }
      return released
    })
  }

  /** Atomically claim the first ready task not skipped, or undefined when none is ready. */
  claimNextReady(owner: string, skip: (task: SwarmTaskSnapshot) => boolean = () => false): Promise<SwarmTaskSnapshot | undefined> {
    return this.transact(async () => {
      const state = this.fold()
      for (const task of state.values()) {
        if (this.ready(task, state) && !skip(task)) {
          return this.commit({
            ...task,
            revision: task.revision + 1,
            status: 'in_progress',
            owner,
            lease: this.journal.incarnation,
          })
        }
      }
      return undefined
    })
  }
}
