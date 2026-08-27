/**
 * RemotePeer — a long-lived, multi-turn subprocess member (docs/01 Phase 4).
 *
 * One `dsh-jsonrpc-agent` runtime per peer, owned across turns through the
 * published SDK client: briefing, every task, and every waking peer message
 * land on ONE session, so the member keeps memory for the team's lifetime.
 * Turns serialize through a promise chain (the child inbox is FIFO anyway);
 * `deliver()` resolves at durable prompt acceptance — the mailbox's
 * delivery-ack boundary — while `ask()` additionally awaits the turn and
 * returns its final assistant text.
 */
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MemberRunResult } from './types'

export interface RemotePeerOptions {
  name: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  provider: string
  model: string
  briefing: string
}

function textOf(blocks: ContentBlock[] | undefined): string {
  return (blocks ?? [])
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export class RemotePeer {
  readonly name: string
  readonly sessionId: string
  private readonly client: HarnessClient
  private turnTail: Promise<unknown> = Promise.resolve()
  private lastAssistant: ContentBlock[] | undefined
  private lastTurnReason: string | undefined
  private turnWaiter: (() => void) | undefined
  private pump: Promise<void> | undefined

  private constructor(name: string, client: HarnessClient) {
    this.name = name
    this.sessionId = `swarm-member-${name}`
    this.client = client
  }

  static async spawn(options: RemotePeerOptions): Promise<RemotePeer> {
    const client = new HarnessClient({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: { ...process.env, ...options.env } as never,
    })
    const peer = new RemotePeer(options.name, client)
    client.start()
    await client.initialize({
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
    } as never)
    peer.startPump()
    await peer.ask([{ type: 'text', text: options.briefing }])
    return peer
  }

  /** Consume the notification stream into turn-end signals + last output. */
  private startPump(): void {
    const subscription = this.client.subscribe(
      (n: any) => n.method === 'session.event' && n.params?.sessionId === this.sessionId,
    )
    this.pump = (async () => {
      try {
        for await (const notification of subscription as any) {
          const event = notification.params?.event
          if (event?.type === 'assistant/message') {
            const content = event.data?.message?.content ?? event.data?.content
            if (Array.isArray(content) && content.length > 0) this.lastAssistant = content
          } else if (event?.type === 'turn/end') {
            this.lastTurnReason = event.data?.reason?.kind
            this.turnWaiter?.()
            this.turnWaiter = undefined
          }
        }
      } catch {
        // Runtime closed; pending waiters are released by close().
      }
    })()
  }

  /** Queue one turn; `accepted` settles at durable prompt acceptance. */
  private enqueueTurn(blocks: ContentBlock[]): {
    accepted: Promise<string>
    done: Promise<MemberRunResult>
  } {
    let resolveAccepted!: (id: string) => void
    let rejectAccepted!: (error: unknown) => void
    const accepted = new Promise<string>((resolve, reject) => {
      resolveAccepted = resolve
      rejectAccepted = reject
    })
    const done = this.turnTail.then(async () => {
      const turnEnded = new Promise<void>((resolve) => {
        this.turnWaiter = resolve
      })
      try {
        resolveAccepted(await this.client.prompt(this.sessionId, blocks))
      } catch (error) {
        rejectAccepted(error)
        throw error
      }
      await turnEnded
      const output = this.lastAssistant ?? []
      const reason = this.lastTurnReason
      return {
        member: this.name,
        runId: this.sessionId,
        output,
        text: textOf(output),
        // Fold the durable turn reason; an errored or aborted member turn is
        // never reported as success.
        stopReason:
          reason === 'completed' ? ('completed' as const)
          : reason === 'aborted' ? ('aborted' as const)
          : ('error' as const),
      }
    })
    this.turnTail = done.then(
      () => undefined,
      () => undefined,
    )
    return { accepted, done }
  }

  /** Deliver waking content; resolves once the child durably accepted it. */
  async deliver(blocks: ContentBlock[]): Promise<string> {
    const { accepted, done } = this.enqueueTurn(blocks)
    void done.then(
      () => undefined,
      () => undefined,
    )
    return accepted
  }

  /** One addressed turn: prompt, await its end, return the final output. */
  ask(blocks: ContentBlock[]): Promise<MemberRunResult> {
    return this.enqueueTurn(blocks).done
  }

  async close(): Promise<void> {
    this.turnWaiter?.()
    this.turnWaiter = undefined
    await this.client.close()
    await this.pump?.catch(() => undefined)
  }
}
