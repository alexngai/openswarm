/**
 * `ctx.swarmAppServer` — the socket carrier of the swarm protocol (docs/05
 * §5.3, D11): one JSON-RPC endpoint for UIs, CLIs and programs.
 *
 * A connection starts unauthenticated: until `swarm/auth { token }` binds its
 * principal from `ctx.swarm.tokens`, every other method is refused. `swarm/*`
 * methods then go through the protocol's `dispatch`, whose policy table is
 * the security boundary. Any other method passes through to dsh's exported
 * `HarnessSdkJsonRpcServer` (wrap, don't fork: `initialize`, `session/prompt`,
 * streamed `session.event` / `session.status`), for owners only; that server
 * streams every session in the process, so only an owner connection gets one.
 *
 * At listen an owner token is minted and written with the URL and pid to
 * `$OPENSWARM_HOME/app-server.json` (mode 0600), for the CLI; close removes
 * it. The connection that starts a run gets a `swarm.runFinished`
 * notification, carrying the TeamResult or the error, when it settles.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { SwarmProtocolError, dispatch, mintToken, openswarmHome, type Principal } from 'openswarm-swarm'

export const Config = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(0),
})

export interface AppServerConfig {
  host?: string
  port?: number
}

export default class SwarmAppServer extends Service {
  static inject = ['agents', 'swarm']

  private server: Server | undefined
  private boundPort = 0
  private readonly sockets = new Set<Socket>()
  /** The owner credential's file and revocation, for close. */
  private owner: { file: string; revoke: () => void } | undefined

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
    // Minted before binding, while the context is surely active; close revokes it.
    const { tokens } = this.ctx.swarm
    const token = mintToken(this.ctx, { role: 'owner' })
    const owner = { file: join(openswarmHome(), 'app-server.json'), revoke: () => tokens.delete(token) }
    this.owner = owner
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port ?? 0, this.config.host ?? '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('app-server did not bind')
    // Closed while binding: the token is revoked, so publish nothing.
    if (this.owner !== owner) return void server.close()
    this.boundPort = address.port
    this.server = server
    mkdirSync(dirname(owner.file), { recursive: true })
    // Written fresh, so a stale file's looser mode cannot carry over.
    rmSync(owner.file, { force: true })
    writeFileSync(owner.file, JSON.stringify({ url: this.url, token, pid: process.pid }), { mode: 0o600 })
    this.markReady()
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    const transport = new JsonRpcLineTransport(socket, socket)
    let principal: Principal | undefined
    let sdk: HarnessSdkJsonRpcServer | undefined
    transport.onRequest(async (method, params) => {
      if (method === 'swarm/auth') {
        if (principal !== undefined) throw new SwarmProtocolError('FORBIDDEN', 'this connection is already authenticated')
        principal = this.ctx.swarm.tokens.get(String(params['token']))
        if (principal === undefined) throw new SwarmProtocolError('FORBIDDEN', 'unknown token')
        if (principal.role === 'owner') sdk = new HarnessSdkJsonRpcServer(this.ctx, transport)
        return { principal }
      }
      if (principal === undefined) throw new SwarmProtocolError('FORBIDDEN', `authenticate with swarm/auth before ${method}`)
      if (!method.startsWith('swarm/')) {
        if (sdk === undefined) throw new SwarmProtocolError('FORBIDDEN', `${principal.role} may not call ${method}`)
        return sdk.handleRequest(method, params)
      }
      const result = await dispatch(this.ctx, principal, method, params)
      if (method === 'swarm/start') {
        const { runId } = result as { runId: string }
        void this.ctx.swarm.live(runId)?.result.then(
          (result) => transport.notify('swarm.runFinished', { runId, result }),
          (error) => transport.notify('swarm.runFinished', { runId, error: String(error?.message ?? error) }),
        )
      }
      return result
    })
    transport.start()
    socket.on('close', () => {
      transport.close()
      this.sockets.delete(socket)
      void sdk?.shutdown().catch(() => undefined)
    })
    socket.on('error', () => socket.destroy())
  }

  async close(): Promise<void> {
    if (this.owner !== undefined) {
      this.owner.revoke()
      rmSync(this.owner.file, { force: true })
      this.owner = undefined
    }
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
