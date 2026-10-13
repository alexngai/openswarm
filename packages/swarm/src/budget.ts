/**
 * Budgets (docs/05 C5): a run's and its tasks' spend limits.
 *
 * Spent is what the run's journal says its member runs spent (`swarm/usage`),
 * dollars as metrics price them: what the runtime reported, else the pricing
 * table. A limit is checked before each member run starts — task rounds,
 * reviews, repairs, resolvers, lead runs — never during one, so a scope
 * overshoots by at most its runs in flight. ponytail: start-time checks over
 * settled usage; cutting a run mid-flight needs usage streamed as it is spent.
 *
 * A scope out of budget asks one high-tier question while its starts wait:
 * `stop` (the default, so an unattended run stops) or `extend`, which grows
 * the limit by its first amount. A dollar limit over usage it cannot price
 * asks at once, and there `extend` drops the dollar limit for that scope. A
 * stopped scope refuses every later start with {@link BudgetStopError}: the
 * board abandons a stopped task, a stopped run starts nothing more, and what
 * passed still lands (docs/05 C7a).
 */
import type { SwarmJournal } from './journal'
import { runUsd, tokensOf, type Pricing, type SwarmUsageEvent } from './metrics'
import type { AskQuestion } from './run'

/** A spend limit; either or both. */
export interface Budget {
  usd?: number
  tokens?: number
}

/** Payload of a `swarm/budget` journal event: a scope ran out, and what was decided. */
export type SwarmBudgetEvent = {
  version: 1
  scope: 'run' | 'task'
  taskId?: string
  /** Why it was out. */
  reason: string
  spent: { usd: number | null; tokens: number }
  outcome: 'stopped' | 'extended'
  /** The limit after the answer. */
  limit: Budget
}

/** A member run refused because its task's or its run's budget was stopped. */
export class BudgetStopError extends Error {
  constructor(
    readonly scope: 'run' | 'task',
    readonly taskId: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'BudgetStopError'
  }
}

/** Refuse a budget that is not a positive amount, before any spend. */
export function validateBudget(budget: Budget | undefined, where: string): void {
  if (budget === undefined) return
  for (const [unit, n] of Object.entries(budget)) {
    if (unit !== 'usd' && unit !== 'tokens') throw new Error(`${where}: unknown budget unit "${unit}" (usd, tokens)`)
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`${where}: budget ${unit} must be a positive number`)
  }
}

interface Scope {
  first: Budget
  limit: Budget
  stopped?: string
  pending?: Promise<void>
}

const fmt = (b: Budget) => [b.usd === undefined ? '' : `$${b.usd.toFixed(2)}`, b.tokens === undefined ? '' : `${b.tokens} tokens`].filter(Boolean).join(' and ')

export class BudgetGuard {
  private readonly scopes = new Map<string, Scope>()

  constructor(
    private readonly deps: {
      journal: SwarmJournal
      ask: AskQuestion
      pricing?: Pricing
      run?: Budget
      /** A task's own budget, by task (worktree) key. */
      task: (key: string) => Budget | undefined
    },
  ) {}

  /** Before a member run starts: resolves when it may, throws {@link BudgetStopError} when its task's or the run's budget is stopped. */
  async admit(taskKey?: string): Promise<void> {
    if (taskKey !== undefined) await this.check(`task:${taskKey}`, taskKey)
    await this.check('run')
  }

  /** What the scope's member runs spent: dollars over the priced ones, and how many could not be priced. */
  spent(taskKey?: string): { usd: number; tokens: number; unpriced: number } {
    let usd = 0
    let tokens = 0
    let unpriced = 0
    for (const { type, data } of this.deps.journal.events) {
      if (type !== 'swarm/usage') continue
      const run = data as SwarmUsageEvent
      if (taskKey !== undefined && run.taskKey !== taskKey) continue
      tokens += tokensOf(run.usage)
      const dollars = runUsd(run, this.deps.pricing)
      if (dollars === undefined) unpriced++
      else usd += dollars
    }
    return { usd, tokens, unpriced }
  }

  private scope(key: string, taskKey?: string): Scope | undefined {
    let scope = this.scopes.get(key)
    if (scope === undefined) {
      const budget = taskKey === undefined ? this.deps.run : this.deps.task(taskKey)
      if (budget === undefined || (budget.usd === undefined && budget.tokens === undefined)) return undefined
      scope = { first: budget, limit: { ...budget } }
      this.scopes.set(key, scope)
    }
    return scope
  }

  private async check(key: string, taskKey?: string): Promise<void> {
    const scope = this.scope(key, taskKey)
    if (scope === undefined) return
    for (;;) {
      if (scope.stopped !== undefined) throw new BudgetStopError(taskKey === undefined ? 'run' : 'task', taskKey, scope.stopped)
      // One question per scope: every start in it waits on that answer.
      if (scope.pending !== undefined) {
        await scope.pending
        continue
      }
      const over = this.over(scope, taskKey)
      if (over === undefined) return
      scope.pending = this.decide(scope, taskKey, over).finally(() => (scope.pending = undefined))
    }
  }

  /** Why the scope is out of budget, or undefined while it is not. */
  private over(scope: Scope, taskKey?: string): { reason: string; unpriced: boolean } | undefined {
    const { usd, tokens, unpriced } = this.spent(taskKey)
    if (scope.limit.tokens !== undefined && tokens >= scope.limit.tokens) {
      return { reason: `spent ${tokens} of ${scope.limit.tokens} tokens`, unpriced: false }
    }
    if (scope.limit.usd !== undefined) {
      if (unpriced > 0) {
        return {
          reason: `${unpriced} member run(s) reported no dollars and have no price (SwarmConfig.pricing) for their model, so its $${scope.limit.usd.toFixed(2)} limit cannot be checked`,
          unpriced: true,
        }
      }
      if (usd >= scope.limit.usd) return { reason: `spent $${usd.toFixed(2)} of $${scope.limit.usd.toFixed(2)}`, unpriced: false }
    }
    return undefined
  }

  private async decide(scope: Scope, taskKey: string | undefined, over: { reason: string; unpriced: boolean }): Promise<void> {
    const what = taskKey === undefined ? 'the run' : `task ${taskKey}`
    const stopping = taskKey === undefined ? 'no member run starts again, and what passed still lands' : 'it and its dependents are abandoned, its branch kept'
    const extending = over.unpriced ? 'continue without the dollar limit' : `extend it by ${fmt(scope.first)}`
    // The default stops, and a capped question takes the default, so only a person extends.
    const answer = await this.deps
      .ask({
        trigger: 'budget',
        kind: 'approval',
        tier: 'high',
        ...(taskKey === undefined ? {} : { taskId: taskKey }),
        prompt: `${what} is out of budget: ${over.reason}. Stop it (${stopping}), or ${extending}?`,
        options: ['stop', 'extend'],
        default: 'stop',
      })
      .catch(() => 'stop')
    if (answer === 'extend') {
      if (over.unpriced) delete scope.limit.usd
      else {
        if (scope.limit.usd !== undefined) scope.limit.usd += scope.first.usd!
        if (scope.limit.tokens !== undefined) scope.limit.tokens += scope.first.tokens!
      }
    } else {
      scope.stopped = `${what} stopped on its budget: ${over.reason}`
    }
    const { usd, tokens, unpriced } = this.spent(taskKey)
    await this.deps.journal.append('swarm/budget', {
      version: 1,
      scope: taskKey === undefined ? 'run' : 'task',
      ...(taskKey === undefined ? {} : { taskId: taskKey }),
      reason: over.reason,
      spent: { usd: unpriced > 0 ? null : usd, tokens },
      outcome: answer === 'extend' ? 'extended' : 'stopped',
      limit: { ...scope.limit },
    } satisfies SwarmBudgetEvent)
  }
}
