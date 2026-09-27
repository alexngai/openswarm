/**
 * `ctx.swarmWeb` — the web carrier of the swarm protocol (docs/05 §5.3, D11):
 * one `@Remote` method per `swarm/*` method, which dsh's `/api` gateway serves
 * as `POST /api/swarm/<method>` with `{ args: { …params } }`. No dsh codegen:
 * the gateway reads each method's parameter names from its source, so they
 * stay plain identifiers (and the build must not minify).
 *
 * Every caller is the owner, because dsh's web server authenticates nothing,
 * so this carrier is safe only on loopback: it refuses to load (which fails
 * the dsh boot) unless `ctx.webServer` binds 127.0.0.1, dsh's only other bind
 * being 0.0.0.0. `swarm/token` stays on the socket carrier, which owns
 * credentials. The gateway has no push, so a view follows a run by
 * long-polling `swarm/events`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only, for the `ctx.webServer` Context augmentation.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dispatch } from 'openswarm-swarm'

export default class SwarmWebCarrier extends TypertRemoteService {
  static inject = ['agents', 'swarm', 'webServer']

  constructor(ctx: Context) {
    const { host } = ctx.webServer
    if (host !== '127.0.0.1') {
      throw new Error(
        `openswarm-app-server/web: dsh's web server binds ${host}, but it authenticates nothing and this ` +
          'carrier treats every caller as the swarm owner; bind 127.0.0.1, or disable the openswarm-app-server-web row',
      )
    }
    super(ctx, 'swarmWeb', { namespace: 'swarm' })
  }

  @Remote runs() {
    return this.call('runs', {})
  }

  @Remote view(runId: string, since?: number) {
    return this.call('view', { runId, since })
  }

  @Remote events(runId: string, afterSeq?: number, waitMs?: number) {
    return this.call('events', { runId, afterSeq, waitMs })
  }

  @Remote start(spec: object, provider?: string, model?: string, worktrees?: object, questionTimeoutMs?: number) {
    return this.call('start', { spec, provider, model, worktrees, questionTimeoutMs })
  }

  @Remote questions(runId?: string) {
    return this.call('questions', { runId })
  }

  @Remote answer(runId: string, questionId: string, answer: string) {
    return this.call('answer', { runId, questionId, answer })
  }

  @Remote steer(runId: string, to: string, text: string) {
    return this.call('steer', { runId, to, text })
  }

  @Remote cancel(runId: string) {
    return this.call('cancel', { runId })
  }

  @Remote attach(runId: string) {
    return this.call('attach', { runId })
  }

  /**
   * One owner call, absent params omitted. The gateway refuses a result that
   * is not plain JSON (an undefined field, say), so it is re-encoded as the
   * socket carrier's JSON-RPC would.
   */
  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined))
    return JSON.parse(JSON.stringify(await dispatch(this.ctx, { role: 'owner' }, `swarm/${method}`, defined)))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    swarmWeb: SwarmWebCarrier
  }
}
