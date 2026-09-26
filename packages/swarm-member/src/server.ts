/**
 * `openswarm-swarm-member/server` — the member's stdio SDK server (docs/05 A2).
 *
 * dsh's `sdk-jsonrpc-server` with two local fixes (D5; delete when upstream
 * lands them): a session missing from memory is RESUMED from persistence when
 * its log exists, so a respawned member keeps its history; and `swarm/steer`
 * delivers `immediate` steering through `agent.steer` (next step boundary),
 * which the stock server, queueing turns only, cannot.
 *
 * `apply` mirrors the stock plugin's: same Config, transport, shutdown/exit.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport, type JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import {
  HarnessSdkJsonRpcServer,
  type HarnessSdkJsonRpcServerOptions,
  type JsonRpcConfig,
} from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { SessionId } from '@deepseek-ai/dsh-session'

export { Config } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
export const name = 'openswarm-swarm-member-server'
export const inject = ['agents']

type SessionRecord = { handle: AgentHandle }

// The base declares these private; they are ordinary members at runtime.
const Base = HarnessSdkJsonRpcServer as unknown as new (
  ctx: Context,
  transport: JsonRpcTransportPeer,
  options?: HarnessSdkJsonRpcServerOptions,
) => {
  readonly ctx: Context
  readonly sessions: Map<string, SessionRecord>
  readonly provider: string
  readonly model: string
  readonly maxTokens: number | undefined
  createSession(sessionId: string): Promise<SessionRecord>
  handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown>
  shutdown(): Promise<unknown>
}

class MemberSdkServer extends Base {
  override async createSession(sessionId: string): Promise<SessionRecord> {
    const persistence = this.ctx.get('sessionPersistence') as
      | { list(): Promise<{ id: string }[]> }
      | undefined
    const persisted = (await persistence?.list())?.some((h) => String(h.id) === sessionId)
    if (persisted !== true) return super.createSession(sessionId)
    const rec = {
      handle: await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: {
          provider: this.provider,
          model: this.model,
          ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
        },
      }),
    }
    this.sessions.set(sessionId, rec)
    return rec
  }

  override async handleRequest(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (method !== 'swarm/steer') return super.handleRequest(method, params)
    const sessionId = String(params?.['sessionId'])
    const text = params?.['text']
    const rec = this.sessions.get(sessionId)
    if (rec === undefined) throw new Error(`swarm/steer: no live session ${sessionId}`)
    if (typeof text !== 'string') throw new TypeError('swarm/steer: text must be a string')
    rec.handle.agent.steer(
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    )
    return { accepted: true }
  }
}

export function apply(ctx: Context, config: JsonRpcConfig): void {
  const rootFiber = ctx.root.fiber
  const exit = config.exit ?? ((code: number) => process.exit(code))
  const transport = new JsonRpcLineTransport(
    config.input ?? process.stdin,
    config.output ?? process.stdout,
  )
  const server = new MemberSdkServer(ctx, transport, {
    maxTokensAsSuccess: config.maxTokensAsSuccess ?? false,
  })
  let exitTask: Promise<void> | undefined
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
  }
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') await ctx.get('loader')?.await()
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') setImmediate(disposeAndExit)
    return result
  })
  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'jsonrpc.serve')
}
