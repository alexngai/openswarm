/**
 * SwarmBoard — the durable shared task board (docs/01 F1).
 *
 * Every mutation appends a whole-snapshot `swarm/task` event to the lead
 * agent's session log and flushes before returning; reads fold the log.
 * Recovery is therefore replay: any process holding the lead session sees the
 * same board. Mutations are serialized per board through a promise-chain
 * tail (the agent-team journal pattern), and every mutation carries an
 * `expectedRevision` compare-and-set so stale writers fail loud instead of
 * overwriting newer state.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
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
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole swarm-task value, stored in the lead session's log. */
    'swarm/task': { version: 1; task: SwarmTaskSnapshot }
  }
}

export type SwarmBoardErrorCode =
  | 'SWARM_TASK_NOT_FOUND'
  | 'SWARM_TASK_STALE_REVISION'
  | 'SWARM_TASK_NOT_READY'
  | 'SWARM_TASK_WRONG_OWNER'
  | 'SWARM_TASK_UNKNOWN_BLOCKER'

export class SwarmBoardError extends Error {
  constructor(
    message: string,
    readonly code: SwarmBoardErrorCode,
  ) {
    super(message)
    this.name = 'SwarmBoardError'
  }
}

type AppendSwarmEvent = (type: 'swarm/task', data: SessionEventMap['swarm/task']) => void

/** Replay the lead session log into current task state, insertion-ordered. */
export function foldBoard(events: ReadonlyArray<{ type: string; data?: unknown }>): Map<string, SwarmTaskSnapshot> {
  const tasks = new Map<string, SwarmTaskSnapshot>()
  for (const event of events) {
    if (event.type !== 'swarm/task') continue
    const { task } = event.data as SessionEventMap['swarm/task']
    tasks.delete(task.id)
    tasks.set(task.id, task)
  }
  return tasks
}

export class SwarmBoard {
  private readonly serial = new Serializer()
  private nextTaskNumber = 0

  constructor(
    private readonly ctx: Context,
    private readonly lead: Agent,
  ) {}

  /** Current folded state (read-only; not serialized against mutations). */
  list(): SwarmTaskSnapshot[] {
    return [...this.fold().values()]
  }

  private fold(): Map<string, SwarmTaskSnapshot> {
    return foldBoard(this.lead.session.events)
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
    // Board events never enter the conversation surface; the narrowed local
    // capability removes append's conditional surface argument (journal pattern).
    const append = this.lead.session.append.bind(this.lead.session) as unknown as AppendSwarmEvent
    append('swarm/task', { version: 1, task })
    await this.ctx.sessions.flush(this.lead.session)
    return task
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

  create(input: { subject: string; prompt: string; blockedBy?: readonly string[] }): Promise<SwarmTaskSnapshot> {
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
      return this.commit({ ...task, revision: task.revision + 1, status: 'in_progress', owner })
    })
  }

  complete(id: string, owner: string, expectedRevision: number, result?: string): Promise<SwarmTaskSnapshot> {
    return this.transact(async () => {
      const task = this.expect(this.fold(), id, expectedRevision)
      if (task.owner !== owner) {
        throw new SwarmBoardError(`task "${id}" is owned by "${task.owner}"`, 'SWARM_TASK_WRONG_OWNER')
      }
      return this.commit({
        ...task,
        revision: task.revision + 1,
        status: 'completed',
        ...(result === undefined ? {} : { result }),
      })
    })
  }

  release(id: string, owner: string, expectedRevision: number): Promise<SwarmTaskSnapshot> {
    return this.transact(async () => {
      const task = this.expect(this.fold(), id, expectedRevision)
      if (task.owner !== owner) {
        throw new SwarmBoardError(`task "${id}" is owned by "${task.owner}"`, 'SWARM_TASK_WRONG_OWNER')
      }
      const { owner: _dropped, ...rest } = task
      return this.commit({ ...rest, revision: task.revision + 1, status: 'pending' })
    })
  }

  /** Atomically claim the first ready task, or undefined when none is ready. */
  claimNextReady(owner: string): Promise<SwarmTaskSnapshot | undefined> {
    return this.transact(async () => {
      const state = this.fold()
      for (const task of state.values()) {
        if (this.ready(task, state)) {
          return this.commit({ ...task, revision: task.revision + 1, status: 'in_progress', owner })
        }
      }
      return undefined
    })
  }
}
