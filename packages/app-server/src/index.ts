/**
 * `ctx.swarmAppServer` — the OpenSwarm app-server (docs/01 F2): one JSON-RPC
 * endpoint any UI/TUI connects to, codex-app-server-shaped.
 *
 * Per TCP connection, dsh's exported `HarnessSdkJsonRpcServer` is
 * instantiated over the connection's `JsonRpcLineTransport` (wrap, don't
 * fork — the Phase-0 probe-3 conclusion): the standard SDK surface
 * (`initialize`, `session/prompt`, streamed `session.event` /
 * `session.status`) delegates to it verbatim, while `swarm/*` methods are
 * handled here:
 *
 *   swarm/runTeam  {spec, provider, model, worktrees?} → {runId}; completion
 *                  arrives as a `swarm.runFinished` notification carrying the
 *                  TeamResult (+ merge outcome under worktrees).
 *   swarm/runs     {} → run list with status.
 *   swarm/board    {runId} → the run's lead-session task board.
 *
 * Loopback by default. UI-grade trust: clients on this socket are the
 * user's own frontends (member harnesses use the separate token-guarded
 * SwarmServer socket).
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SwarmTaskSnapshot, TeamSpec } from 'openswarm-swarm'

export const Config = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(0),
})

export interface AppServerConfig {
  host?: string
  port?: number
}

interface RunRecord {
  runId: string
  status: 'running' | 'finished' | 'failed'
  leadSessionId: string
  /** Board snapshot captured at finish, so swarm/board survives lead disposal. */
  tasks: SwarmTaskSnapshot[]
  /** Idempotent lead teardown. */
  dispose: () => Promise<void>
}

export default class SwarmAppServer extends Service {
  static inject = ['agents', 'swarm']

  private server: Server | undefined
  private boundPort = 0
  private readonly sockets = new Set<Socket>()
  private readonly runs = new Map<string, RunRecord>()

  constructor(
    ctx: Context,
    private readonly config: AppServerConfig = {},
  ) {
    super(ctx, 'swarmAppServer')
    ctx.effect(() => {
      void this.listen()
      return () => void this.close()
    })
  }

  get url(): string {
    if (this.boundPort === 0) throw new Error('app-server is not listening yet')
    return `${this.config.host ?? '127.0.0.1'}:${this.boundPort}`
  }

  /** Resolves once the socket is bound (config port 0 picks an ephemeral one). */
  ready: Promise<void> = new Promise(() => {})
  private markReady!: () => void

  private async listen(): Promise<void> {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve
    })
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port ?? 0, this.config.host ?? '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('app-server did not bind')
    this.boundPort = address.port
    this.server = server
    this.markReady()
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    const transport = new JsonRpcLineTransport(socket, socket)
    const inner = new HarnessSdkJsonRpcServer(this.ctx, transport)
    transport.onRequest(async (method, params) => {
      if (method.startsWith('swarm/')) return this.handleSwarm(method, params ?? {}, transport)
      return inner.handleRequest(method, params)
    })
    transport.start()
    socket.on('close', () => {
      transport.close()
      this.sockets.delete(socket)
      void inner.shutdown().catch(() => undefined)
    })
    socket.on('error', () => socket.destroy())
  }

  private async handleSwarm(
    method: string,
    params: Record<string, unknown>,
    transport: JsonRpcLineTransport,
  ): Promise<unknown> {
    switch (method) {
      case 'swarm/runTeam': {
        const spec = params['spec'] as TeamSpec | undefined
        if (spec === undefined || typeof spec !== 'object') throw new Error('swarm/runTeam: spec is required')
        const provider = String(params['provider'] ?? 'deepseek-official')
        const model = params['model'] === undefined ? undefined : String(params['model'])
        const runId = `run-${randomUUID().slice(0, 8)}`
        const lead = await this.ctx.agents.create({
          sessionId: SessionId(`swarm-app-${runId}`),
          meta: { cwd: process.cwd() },
          agentOptions: { provider, ...(model === undefined ? {} : { model }) },
        } as never)
        let disposed = false
        const record: RunRecord = {
          runId,
          status: 'running',
          leadSessionId: String(lead.agent.id),
          tasks: [],
          dispose: async () => {
            if (disposed) return
            disposed = true
            await lead.dispose()
          },
        }
        this.runs.set(runId, record)
        // Capture the final board and dispose the lead once the run settles, so
        // leads don't accumulate for the server's lifetime; swarm/board then
        // reads the snapshot.
        const settle = (status: 'finished' | 'failed', payload: Record<string, unknown>) => {
          record.status = status
          record.tasks = this.ctx.swarm.board(lead.agent).list()
          transport.notify('swarm.runFinished', { runId, ...payload })
          void record.dispose().catch(() => undefined)
        }
        void this.ctx.swarm
          .runTeam(spec, {
            parent: lead.agent,
            ...(params['worktrees'] === undefined ? {} : { worktrees: params['worktrees'] as never }),
          })
          .then(
            (result) => settle('finished', { result }),
            (error) => settle('failed', { error: String(error?.message ?? error) }),
          )
        return { runId }
      }
      case 'swarm/runs':
        return {
          runs: [...this.runs.values()].map((r) => ({
            runId: r.runId,
            status: r.status,
            leadSessionId: r.leadSessionId,
          })),
        }
      case 'swarm/board': {
        const runId = String(params['runId'] ?? '')
        const record = this.runs.get(runId)
        if (record === undefined) throw new Error(`unknown run "${runId}"`)
        // Live board while the run is in flight; the captured snapshot after the
        // lead has been disposed.
        const lead = this.ctx.agents.get(record.leadSessionId as never)
        return { tasks: lead !== undefined ? this.ctx.swarm.board(lead).list() : record.tasks }
      }
      default:
        throw new Error(`unknown swarm method: ${method}`)
    }
  }

  async close(): Promise<void> {
    for (const record of this.runs.values()) await record.dispose().catch(() => undefined)
    this.runs.clear()
    for (const socket of this.sockets) socket.destroy()
    if (this.server !== undefined) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = undefined
    }
    this.boundPort = 0
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    swarmAppServer: SwarmAppServer
  }
}
