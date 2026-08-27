/**
 * SwarmServer — the lead's wire endpoint for member harnesses (docs/01
 * Phase 4; the F2 app-server seed). Newline-delimited JSON-RPC 2.0 over a
 * loopback TCP socket, framed by the published `JsonRpcLineTransport`.
 *
 * One method for now: `swarm/send` — a member's model-facing
 * `swarm_send_message` call lands here and enters the lead's durable
 * mailbox. Sender identity comes from the per-member token minted at spawn,
 * never from caller-supplied fields, so a member cannot speak as another.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SwarmMailbox, SwarmMessageDelivery } from './mailbox'

export class SwarmServer {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private readonly transports = new Set<JsonRpcLineTransport>()
  private readonly tokens = new Map<string, string>()
  private port = 0

  constructor(private readonly mailbox: SwarmMailbox) {}

  /** Mint the spawn-time credential identifying one member. */
  addMember(name: string): string {
    const token = randomUUID()
    this.tokens.set(token, name)
    return token
  }

  /** `host:port` for members' `OPENSWARM_SWARM_URL`. */
  get url(): string {
    if (this.port === 0) throw new Error('swarm server is not listening')
    return `127.0.0.1:${this.port}`
  }

  async listen(): Promise<void> {
    const server = createServer((socket) => {
      this.sockets.add(socket)
      const transport = new JsonRpcLineTransport(socket, socket)
      this.transports.add(transport)
      transport.onRequest(async (method, params) => {
        if (method !== 'swarm/send') throw new Error(`unknown swarm method: ${method}`)
        const from = this.tokens.get(String(params['token'] ?? ''))
        if (from === undefined) throw new Error('unknown member token')
        const message = await this.mailbox.send({
          from,
          to: String(params['to'] ?? ''),
          text: String(params['message'] ?? ''),
          ...(params['delivery'] === undefined
            ? {}
            : { delivery: params['delivery'] as SwarmMessageDelivery }),
        })
        return { messageId: message.id }
      })
      transport.start()
      socket.on('close', () => {
        transport.close()
        this.transports.delete(transport)
        this.sockets.delete(socket)
      })
      socket.on('error', () => socket.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('swarm server did not bind')
    this.port = address.port
    this.server = server
  }

  async close(): Promise<void> {
    for (const transport of this.transports) transport.close()
    for (const socket of this.sockets) socket.destroy()
    if (this.server !== undefined) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = undefined
    }
    this.port = 0
  }
}
