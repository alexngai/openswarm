/**
 * The swarm protocol (docs/05 §5.3, D11): one transport-free `swarm/*` method
 * table behind a default-deny policy. A carrier binds it to a transport and
 * establishes the caller's principal from its own credential (the app-server
 * socket's token); identity never comes from params.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Type-only, for the `ctx.agentDefaultModel` Context augmentation.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { landingText } from './evidence'
import type { RunHandle } from './index'
import { SwarmJournal, type SwarmJournalEvent } from './journal'
import { metricsRows } from './metrics'
import { foldQuestions, foldRun } from './run'

export type Role = 'owner' | 'viewer' | 'driver' | 'member'

/**
 * The caller, as its carrier established it. A member is bound to one run and
 * member name; a viewer or driver token may also name a run to be bound to.
 * Lead-member and foreign-swarm principals arrive with nesting and the mesh.
 */
export interface Principal {
  role: Role
  runId?: string
  member?: string
}

export type MethodGroup = 'state' | 'direction' | 'answer' | 'member' | 'admin'

/**
 * The groups each role may call; anything else is refused. A driver's
 * `answer` is tiered further by `swarm/answer` itself, and `member` takes
 * member-side methods as they move onto the protocol. The socket carrier adds
 * dsh's SDK pass-through, for owners only.
 */
export const POLICY: Readonly<Record<Role, readonly MethodGroup[]>> = {
  owner: ['state', 'direction', 'answer', 'admin'],
  viewer: ['state'],
  driver: ['state', 'direction', 'answer'],
  member: ['member', 'state'],
}

export type SwarmProtocolErrorCode = 'FORBIDDEN' | 'UNKNOWN_METHOD' | 'INVALID_PARAMS' | 'NOT_FOUND'

export class SwarmProtocolError extends Error {
  constructor(
    readonly code: SwarmProtocolErrorCode,
    message: string,
  ) {
    // A JSON-RPC line transport carries only the message, so the code leads it.
    super(`${code}: ${message}`)
    this.name = 'SwarmProtocolError'
  }
}

type Params = Record<string, any>

interface Method {
  group: MethodGroup
  /** Accepted params by type; a name ending in `?` is optional. */
  params: Record<string, 'string' | 'number' | 'object'>
  handle(ctx: Context, params: Params, principal: Principal): unknown
}

const invalid = (method: string, message: string) =>
  new SwarmProtocolError('INVALID_PARAMS', `${method}: ${message}`)

/** The run a non-owner principal is confined to, if any; a member always is. */
function boundRun(principal: Principal): string | undefined {
  if (principal.role === 'owner') return undefined
  if (principal.role === 'member' && principal.runId === undefined) {
    throw new SwarmProtocolError('FORBIDDEN', 'a member principal must be bound to a run')
  }
  return principal.runId
}

/** A run's journal: in memory while it is live here, else read from its file. */
function eventsOf(ctx: Context, runId: string): readonly SwarmJournalEvent[] {
  const events = ctx.swarm.live(runId)?.journal.events ?? SwarmJournal.read(ctx.swarm.journalPath(runId))
  if (foldRun(events) === undefined) throw new SwarmProtocolError('NOT_FOUND', `unknown run "${runId}"`)
  return events
}

function liveRun(ctx: Context, runId: string): RunHandle {
  const run = ctx.swarm.live(runId)
  if (run === undefined) throw new SwarmProtocolError('NOT_FOUND', `run "${runId}" is not live in this process`)
  return run
}

/** A fresh random credential for `principal`, resolved through `ctx.swarm.tokens`. */
export function mintToken(ctx: Context, principal: Principal): string {
  const token = randomBytes(32).toString('base64url')
  ctx.swarm.tokens.set(token, principal)
  return token
}

const METHODS: Record<string, Method> = {
  'swarm/runs': {
    group: 'state',
    params: {},
    handle: (ctx, _params, principal) => {
      const bound = boundRun(principal)
      return { runs: ctx.swarm.runs().filter((run) => bound === undefined || run.id === bound) }
    },
  },
  'swarm/view': {
    group: 'state',
    params: { runId: 'string', 'since?': 'number' },
    handle: (ctx, { runId, since }) => {
      eventsOf(ctx, runId)
      return ctx.swarm.view(runId, { since })
    },
  },
  'swarm/events': {
    group: 'state',
    params: { runId: 'string', 'afterSeq?': 'number', 'waitMs?': 'number' },
    handle: async (ctx, { runId, afterSeq = -1, waitMs = 0 }) => {
      // Only a live run can grow; a settled one answers from its file at once.
      await ctx.swarm.live(runId)?.journal.waitForAppend(afterSeq, Math.min(waitMs, 30_000))
      return { events: eventsOf(ctx, runId).filter((event) => event.seq > afterSeq) }
    },
  },
  'swarm/questions': {
    group: 'state',
    params: { 'runId?': 'string' },
    handle: (ctx, { runId }, principal) => {
      // Every live run's, or one run's, folded from its file if not live here.
      const only = runId ?? boundRun(principal)
      const runIds = only === undefined ? ctx.swarm.live().map((run) => run.id) : [only]
      return {
        questions: runIds.flatMap((id) =>
          [...foldQuestions(eventsOf(ctx, id)).values()]
            .filter((question) => question.status === 'open')
            .map((question) => ({ runId: id, ...question })),
        ),
      }
    },
  },
  // Read-only: reprioritizing, retaining or taking over a landing is not built yet (docs/05 §6.1).
  'swarm/landings': {
    group: 'state',
    params: { runId: 'string' },
    // One read of each journal: the run's (in memory while live) shared with the fold.
    handle: (ctx, { runId }) => ({
      landings: ctx.swarm.landings(runId, eventsOf(ctx, runId)).map((landing) => ({ ...landing, text: landingText(landing, ctx.swarm.pricing) })),
    }),
  },
  'swarm/metrics': {
    group: 'state',
    params: { runId: 'string' },
    handle: (ctx, { runId }) => {
      const metrics = ctx.swarm.metrics(runId, eventsOf(ctx, runId))
      return { metrics, rows: metricsRows(metrics) }
    },
  },
  'swarm/answer': {
    group: 'answer',
    params: { runId: 'string', questionId: 'string', answer: 'string' },
    handle: (ctx, { runId, questionId, answer }, principal) => {
      const run = liveRun(ctx, runId)
      const question = foldQuestions(run.journal.events).get(questionId)
      const missing = () => new SwarmProtocolError('NOT_FOUND', `run ${runId} has no open question "${questionId}"`)
      if (question?.status !== 'open') throw missing()
      // A driver answers only low tiers; a consent or approval needs a human (P8).
      const human = question.kind === 'consent' || question.kind === 'approval'
      if (principal.role !== 'owner' && (question.tier !== 'low' || human)) {
        throw new SwarmProtocolError('FORBIDDEN', `${principal.role} may not answer ${question.tier}-tier ${question.kind} ${questionId}`)
      }
      if (!question.options.includes(answer)) {
        throw invalid('swarm/answer', `answer must be one of ${question.options.join(', ')}`)
      }
      try {
        run.answer(questionId, answer, principal.role)
      } catch {
        // Closed a moment ago, its record still being written.
        throw missing()
      }
      return { answered: true }
    },
  },
  'swarm/start': {
    group: 'direction',
    params: {
      spec: 'object',
      'provider?': 'string',
      'model?': 'string',
      'worktrees?': 'object',
      'questionTimeoutMs?': 'number',
    },
    // A person is attached to a run started here, so its questions wait for one (5 min by default).
    handle: async (ctx, { spec, provider, model, worktrees, questionTimeoutMs = 300_000 }) => {
      // Unnamed, the route is the harness's default model (the profile's
      // agent-default-model row), as dsh's headless runner resolves it. An agent
      // created without one has none: dsh does not fall back on its own.
      const fallback = ctx.get('agentDefaultModel')?.currentSelection()
      provider ??= fallback?.provider
      model ??= fallback?.model
      const lead = await ctx.agents.create({
        sessionId: `swarm-app-${randomUUID()}`,
        meta: { cwd: process.cwd() },
        agentOptions: { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) },
      } as never)
      const run = await ctx.swarm
        .start(spec, {
          parent: lead.agent,
          questions: { timeoutMs: questionTimeoutMs },
          ...(worktrees === undefined ? {} : { worktrees }),
        })
        .catch(async (error: unknown) => {
          await lead.dispose()
          throw error
        })
      // The run's journal is its record, so the lead goes once the run settles.
      void run.result.finally(() => lead.dispose()).catch(() => undefined)
      return { runId: run.id }
    },
  },
  'swarm/steer': {
    group: 'direction',
    params: { runId: 'string', to: 'string', text: 'string' },
    handle: async (ctx, { runId, to, text }, principal) => ({
      delivery: await liveRun(ctx, runId).steer(to, text, principal.role),
    }),
  },
  'swarm/cancel': {
    group: 'direction',
    params: { runId: 'string' },
    handle: (ctx, { runId }) => {
      liveRun(ctx, runId).cancel()
      return { cancelled: true }
    },
  },
  'swarm/attach': {
    group: 'direction',
    params: { runId: 'string' },
    handle: (ctx, { runId }) => {
      eventsOf(ctx, runId)
      return ctx.swarm.attach(runId)
    },
  },
  'swarm/token': {
    group: 'admin',
    params: { role: 'string', 'runId?': 'string', 'member?': 'string' },
    handle: (ctx, { role, runId, member }) => {
      if (!Object.hasOwn(POLICY, role)) {
        throw invalid('swarm/token', `role must be one of ${Object.keys(POLICY).join(', ')}`)
      }
      if ((role === 'member') !== (member !== undefined) || (role === 'member' && runId === undefined)) {
        throw invalid('swarm/token', 'a member token needs runId and member; no other role takes a member')
      }
      const principal: Principal = { role, ...(runId === undefined ? {} : { runId }), ...(member === undefined ? {} : { member }) }
      return { token: mintToken(ctx, principal) }
    },
  },
}

/**
 * Run one `swarm/*` call for `principal`: policy first (default-deny), then
 * params, then the handler. A refused, unknown or malformed call, or an
 * unknown run, throws {@link SwarmProtocolError}.
 */
export async function dispatch(
  ctx: Context,
  principal: Principal,
  method: string,
  params: unknown,
): Promise<unknown> {
  const entry = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined
  if (entry === undefined) throw new SwarmProtocolError('UNKNOWN_METHOD', `unknown swarm method: ${method}`)
  if (!POLICY[principal.role]?.includes(entry.group)) {
    throw new SwarmProtocolError('FORBIDDEN', `${principal.role} may not call ${method}`)
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalid(method, 'params must be an object')
  }
  const p = params as Params
  for (const [name, type] of Object.entries(entry.params)) {
    const key = name.replace(/\?$/, '')
    if (p[key] === undefined && name.endsWith('?')) continue
    if (typeof p[key] !== type || p[key] === null || Array.isArray(p[key])) {
      throw invalid(method, `${key} must be ${type === 'object' ? 'an object' : `a ${type}`}`)
    }
  }
  if (p['runId'] !== undefined && !/^[\w-]+$/.test(p['runId'])) throw invalid(method, `invalid run id "${p['runId']}"`)
  // A bound principal lists only its run and addresses no other; starting one is another.
  const bound = boundRun(principal)
  const addressesBound = ('runId' in entry.params || 'runId?' in entry.params) && p['runId'] === bound
  const lists = method === 'swarm/runs' || (method === 'swarm/questions' && p['runId'] === undefined)
  if (bound !== undefined && !lists && !addressesBound) {
    throw new SwarmProtocolError('FORBIDDEN', `${method}: this principal is bound to run ${bound}`)
  }
  return entry.handle(ctx, p, principal)
}
