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
 * to complete a task without passing evidence (docs/05 B6, exit criterion 4).
 */
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
  /** What closed it, when it closed through the gate or a human waived it. */
  readonly evidence?: TaskEvidence
}

/**
 * What a completed task closed on (docs/05 B6): the gate round that passed,
 * or a human who accepted it without (P8: only a human principal waives the
 * gate). The precursor of B0's `verifies` edge.
 */
export interface TaskEvidence {
  readonly kind: 'commands' | 'review' | 'human'
  readonly passed: boolean
  /** The gate round whose evidence this is. */
  readonly round?: number
  /** Review: the reviewer's 0–100 estimate; null when its verdict did not parse. */
  readonly score?: number | null
  /** Review: each target's status, with what an unverifiable one could not run. */
  readonly targets?: readonly { target: number; status: string; notes?: string }[]
  readonly failedCommands?: readonly string[]
  /**
   * The snapshot commit of the tree the evidence is about. ponytail: no ref
   * points at it, so `git gc` may prune it once old enough; B0's `verifies`
   * edge must pin it (a ref, or the landed commit) to stay checkable.
   */
  readonly snapshot?: string
  /** Human: who accepted it. */
  readonly by?: string
}

/** `commands, round 2`, or `human: owner`: a task's evidence in a few words. */
export function evidenceText(evidence: TaskEvidence): string {
  return evidence.kind === 'human' ? `human: ${evidence.by}` : `${evidence.kind}, round ${evidence.round}`
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
  kind: 'commands' | 'review'
  passed: boolean
  score?: number | null
  targets?: { target: number; status: string; notes?: string }[]
  failedCommands?: string[]
  /** The round broke a check the round before passed, and was undone. */
  rolledBack?: boolean
  /** Review: why it could not run. */
  error?: string
  /** The snapshot commit of the tree the round left: what its evidence is about. */
  snapshot?: string
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

/** Replay the journal into current task state, insertion-ordered. */
export function foldBoard(events: ReadonlyArray<{ type: string; data?: unknown }>): Map<string, SwarmTaskSnapshot> {
  const tasks = new Map<string, SwarmTaskSnapshot>()
  for (const event of events) {
    if (event.type !== 'swarm/task') continue
    const { task } = event.data as SwarmTaskEvent
    tasks.delete(task.id)
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
    /** `gated`: `complete` requires passing evidence, so no path closes a task unverified. */
    private readonly options: { gated?: boolean } = {},
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
