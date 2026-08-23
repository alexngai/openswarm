/**
 * SwarmMailbox — durable peer messaging over the lead session log.
 *
 * Same journal pattern as the board: `swarm/message/queued` is appended and
 * flushed BEFORE delivery is attempted; `swarm/message/delivered` is appended
 * only after the target durably accepted the message. Queued-minus-delivered
 * is the recovery mailbox. The guarantee is process-local retry plus stable
 * message identity in the delivered framing — not cross-process exactly-once
 * (the dsh agent-team contract, adopted deliberately).
 *
 * Delivery: `wakeup` rides the continuable-subagent seam
 * (`ctx.subagents.followup`) and becomes the target's next FIFO turn — any
 * pending quiet mail for the same target rides along in front of it. `quiet`
 * never delivers immediately: continuable activations are transient, and an
 * injected message dies with a disposed activation, so quiet mail stays
 * durably queued until it rides a waking delivery.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { PeerHandle } from './types'

export type SwarmMessageDelivery = 'quiet' | 'wakeup'

/** Whole durable message value, written before delivery is attempted. */
export interface SwarmMessageSnapshot {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly delivery: SwarmMessageDelivery
  readonly text: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable mailbox enqueue, stored in the lead session before delivery. */
    'swarm/message/queued': { version: 1; message: SwarmMessageSnapshot }
    /** Durable acknowledgement that the target accepted the message. */
    'swarm/message/delivered': { version: 1; messageId: string }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'swarm-message': { kind: 'swarm-message'; messageId: string; from: string }
  }
}

type AppendMailboxEvent = <T extends 'swarm/message/queued' | 'swarm/message/delivered'>(
  type: T,
  data: SessionEventMap[T],
) => void

/** Model-facing framing; repeats the durable identity for target-side dedup. */
export function frameMessage(message: SwarmMessageSnapshot): ContentBlock[] {
  return [
    { type: 'text', text: `Swarm message ${message.id} from ${message.from}:\n${message.text}` },
  ]
}

/** Replay the lead log into the undelivered (queued-minus-delivered) mailbox. */
export function foldPendingMessages(
  events: ReadonlyArray<{ type: string; data?: unknown }>,
): SwarmMessageSnapshot[] {
  const queued = new Map<string, SwarmMessageSnapshot>()
  for (const event of events) {
    if (event.type === 'swarm/message/queued') {
      const { message } = event.data as SessionEventMap['swarm/message/queued']
      queued.set(message.id, message)
    } else if (event.type === 'swarm/message/delivered') {
      queued.delete((event.data as SessionEventMap['swarm/message/delivered']).messageId)
    }
  }
  return [...queued.values()]
}

export class SwarmMailbox {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly lead: Agent,
    private readonly roster: Map<string, PeerHandle>,
  ) {}

  pending(): SwarmMessageSnapshot[] {
    return foldPendingMessages(this.lead.session.events)
  }

  private transact<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async append(
    type: 'swarm/message/queued' | 'swarm/message/delivered',
    data: SessionEventMap['swarm/message/queued'] | SessionEventMap['swarm/message/delivered'],
  ): Promise<void> {
    const append = this.lead.session.append.bind(this.lead.session) as unknown as AppendMailboxEvent
    append(type as never, data as never)
    await this.ctx.sessions.flush(this.lead.session)
  }

  /**
   * Queue one durable message, then attempt immediate delivery. The returned
   * snapshot identifies the durable message whether or not delivery happened;
   * an undelivered message stays pending until a later waking delivery.
   */
  send(input: {
    from: string
    to: string
    text: string
    delivery?: SwarmMessageDelivery
  }): Promise<SwarmMessageSnapshot> {
    return this.transact(async () => {
      if (!this.roster.has(input.to)) throw new Error(`unknown peer "${input.to}"`)
      const message: SwarmMessageSnapshot = {
        id: `msg-${randomUUID()}`,
        from: input.from,
        to: input.to,
        delivery: input.delivery ?? 'wakeup',
        text: input.text,
      }
      await this.append('swarm/message/queued', { version: 1, message })
      await this.deliver(message)
      return message
    })
  }

  /**
   * Frame the pending quiet mail for one peer so a waking delivery can carry
   * it. The caller prepends `blocks` to the waking content and calls `ack()`
   * once that delivery was accepted.
   */
  framePendingQuiet(to: string): { blocks: ContentBlock[]; ack: () => Promise<void> } {
    const messages = this.pending().filter((m) => m.to === to && m.delivery === 'quiet')
    return {
      blocks: messages.flatMap((m) => frameMessage(m)),
      ack: async () => {
        for (const m of messages) await this.append('swarm/message/delivered', { version: 1, messageId: m.id })
      },
    }
  }

  private async deliver(message: SwarmMessageSnapshot): Promise<void> {
    const target = this.roster.get(message.to)
    if (target === undefined) return
    const source = { kind: 'swarm-message', messageId: message.id, from: message.from } as const
    if (message.delivery === 'wakeup') {
      // Pending quiet mail for the same target rides in front of the wakeup.
      const prelude = this.framePendingQuiet(message.to)
      await this.ctx.subagents.followup(
        this.lead,
        target.childId,
        [...prelude.blocks, ...frameMessage(message)],
        { source, signal: new AbortController().signal },
      )
      await prelude.ack()
      await this.append('swarm/message/delivered', { version: 1, messageId: message.id })
    }
    // Quiet: stays queued until the next waking delivery to the target.
    // Immediate injection into a resident activation is deliberately NOT
    // attempted: continuable activations are transient, and an injected
    // message dies with a disposed activation — an acked-but-lost delivery.
    // Inject returns when delivery can verify the durable child inbox.
  }
}
