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
  /**
   * Fail a turn that produces NO session event for this long (default 5min).
   *
   * Idle is measured on the event stream, not on turn completion, so a member
   * legitimately grinding through tool calls keeps resetting it — a bash tool
   * capped at 60s cannot outlast it. What it catches is the child that is
   * alive but wedged, which the stream-ended check cannot see.
   */
  idleTimeoutMs?: number
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
  /** Set when the child's stream ends before we asked it to; turns fail with it. */
  private died: Error | undefined
  private closing = false
  private readonly idleTimeoutMs: number
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(name: string, client: HarnessClient, idleTimeoutMs: number) {
    this.name = name
    this.sessionId = `swarm-member-${name}`
    this.client = client
    this.idleTimeoutMs = idleTimeoutMs
  }

  static async spawn(options: RemotePeerOptions): Promise<RemotePeer> {
    const client = new HarnessClient({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: { ...process.env, ...options.env } as never,
    })
    const peer = new RemotePeer(options.name, client, options.idleTimeoutMs ?? 300_000)
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
          // Any event is progress, not just turn/end.
          if (this.idleTimer !== undefined) this.armIdle()
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
        // Fall through: the stream ending IS the signal, error or not.
      }
      // The subscription only ends when the child runtime is gone. If we did
      // not ask for that, every turn waiting on `turn/end` would otherwise
      // wait forever — and the team's own teardown, which would have released
      // them, sits behind that same await. Fail loud instead of deadlocking.
      if (!this.closing) {
        this.died ??= new Error(
          `swarm member "${this.name}" exited before its turn completed`,
        )
      }
      this.turnWaiter?.()
      this.turnWaiter = undefined
    })()
  }

  /**
   * (Re)start the idle clock. Expiry is treated exactly like a death: the
   * pending turn fails loud and the runtime is torn down, because a wedged
   * child holds a worktree and a model session open indefinitely.
   */
  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.closing) return
      this.died ??= new Error(
        `swarm member "${this.name}" produced no output for ${this.idleTimeoutMs}ms`,
      )
      this.turnWaiter?.()
      this.turnWaiter = undefined
      // Reap it; nothing is coming, and the process would otherwise linger.
      void this.client.close().catch(() => undefined)
    }, this.idleTimeoutMs)
    if (typeof this.idleTimer === 'object' && 'unref' in this.idleTimer) this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
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
      if (this.died !== undefined) {
        rejectAccepted(this.died)
        throw this.died
      }
      const turnEnded = new Promise<void>((resolve) => {
        this.turnWaiter = resolve
      })
      this.armIdle()
      try {
        resolveAccepted(await this.client.prompt(this.sessionId, blocks))
      } catch (error) {
        rejectAccepted(error)
        throw error
      }
      await turnEnded
      this.clearIdle()
      // Released by the pump rather than by a real `turn/end`.
      if (this.died !== undefined) throw this.died
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
    this.closing = true
    this.clearIdle()
    this.turnWaiter?.()
    this.turnWaiter = undefined
    await this.client.close()
    await this.pump?.catch(() => undefined)
  }
}
