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
 *   swarm/runs     {} → {runs}: every run record in the runs directory, so the
 *                  list survives a restart.
 *   swarm/board    {runId} → {tasks}: the live board of a run this process
 *                  owns, else the board read from the run's journal.
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
import type { RunHandle, TeamSpec } from 'openswarm-swarm'

export const Config = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(0),
})

export interface AppServerConfig {
  host?: string
  port?: number
}

/** A run this process started and has not yet settled. */
interface LiveRun {
  handle: RunHandle
  /** Idempotent lead teardown. */
  dispose: () => Promise<void>
}

export default class SwarmAppServer extends Service {
  static inject = ['agents', 'swarm']

  private server: Server | undefined
  private boundPort = 0
  private readonly sockets = new Set<Socket>()
  private readonly live = new Map<string, LiveRun>()

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
        const lead = await this.ctx.agents.create({
          sessionId: SessionId(`swarm-app-${randomUUID()}`),
          meta: { cwd: process.cwd() },
          agentOptions: { provider, ...(model === undefined ? {} : { model }) },
        } as never)
        let disposed = false
        const dispose = async () => {
          if (disposed) return
          disposed = true
          await lead.dispose()
        }
        const handle = await this.ctx.swarm
          .start(spec, {
            parent: lead.agent,
            ...(params['worktrees'] === undefined ? {} : { worktrees: params['worktrees'] as never }),
          })
          .catch(async (error: unknown) => {
            await dispose()
            throw error
          })
        this.live.set(handle.id, { handle, dispose })
        // The run's journal is its record, so the lead is disposed once the run
        // settles rather than accumulating for the server's lifetime.
        const settle = (payload: Record<string, unknown>) => {
          this.live.delete(handle.id)
          transport.notify('swarm.runFinished', { runId: handle.id, ...payload })
          void dispose().catch(() => undefined)
        }
        void handle.result.then(
          (result) => settle({ result }),
          (error) => settle({ error: String(error?.message ?? error) }),
        )
        return { runId: handle.id }
      }
      case 'swarm/runs':
        return { runs: this.ctx.swarm.runs() }
      case 'swarm/board': {
        const runId = String(params['runId'] ?? '')
        const live = this.live.get(runId)
        return { tasks: live !== undefined ? live.handle.board().list() : this.ctx.swarm.view(runId).tasks }
      }
      default:
        throw new Error(`unknown swarm method: ${method}`)
    }
  }

  async close(): Promise<void> {
    for (const run of this.live.values()) await run.dispose().catch(() => undefined)
    this.live.clear()
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
