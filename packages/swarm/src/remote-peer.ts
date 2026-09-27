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
   * Nudge a turn that produces NO session event for this long (default 5min),
   * and fail it after as long again unless `onStall` says wait.
   *
   * Idle is measured on the event stream, not on turn completion, so a member
   * legitimately grinding through tool calls keeps resetting it — a bash tool
   * capped at 60s cannot outlast it. What it catches is the child that is
   * alive but wedged, which the stream-ended check cannot see.
   */
  idleTimeoutMs?: number
  /**
   * Asked when the idle clock expires again after a nudge (docs/05 §6.1):
   * 'restart' fails the turn as a death (the default); 'wait' grants one more
   * idle window, after which it is asked again.
   */
  onStall?: () => Promise<'restart' | 'wait'>
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

  private constructor(
    name: string,
    client: HarnessClient,
    idleTimeoutMs: number,
    private readonly onStall: () => Promise<'restart' | 'wait'>,
  ) {
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
    const peer = new RemotePeer(
      options.name,
      client,
      options.idleTimeoutMs ?? 300_000,
      options.onStall ?? (async () => 'restart'),
    )
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
          // Any event is progress, not just turn/end, except our own input
          // (a prompt or a nudge) echoed back as it lands in the inbox.
          if (this.idleTimer !== undefined && event?.type !== 'agent/inbox/spliced') this.armIdle()
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
   * (Re)start the idle clock. The first expiry nudges the member through
   * `steer` and re-arms; the next asks `onStall`. 'restart' is treated exactly
   * like a death: the pending turn fails loud and the runtime is torn down,
   * because a wedged child holds a worktree and a model session open
   * indefinitely. 'wait' re-arms once more.
   */
  private armIdle(nudged = false): void {
    this.clearIdle()
    const timer = setTimeout(async () => {
      if (this.closing) return
      if (!nudged) {
        // Fire and forget: a wedged child may never answer the request.
        this.steer(
          `You have produced no output for ${Math.round(this.idleTimeoutMs / 1000)}s. If you are stuck, try another approach.`,
        ).catch(() => undefined)
        return this.armIdle(true)
      }
      const choice = await this.onStall().catch(() => 'restart' as const)
      // Progress, the turn's end or close while that was pending moved the clock on.
      // ponytail: the question behind a moot answer stays open until answered or
      // timed out; pass onStall a signal to withdraw it if moot ones crowd the cap.
      if (this.idleTimer !== timer || this.closing) return
      if (choice === 'wait') return this.armIdle(true)
      this.idleTimer = undefined
      this.died ??= new Error(
        `swarm member "${this.name}" produced no output for ${this.idleTimeoutMs}ms after a nudge`,
      )
      this.turnWaiter?.()
      this.turnWaiter = undefined
      // Reap it; nothing is coming, and the process would otherwise linger.
      void this.client.close().catch(() => undefined)
    }, this.idleTimeoutMs)
    this.idleTimer = timer
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
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

  /**
   * `immediate` steering: lands at the member's next step boundary, inside
   * the running turn (member server's `swarm/steer`, docs/05 A2).
   */
  async steer(text: string): Promise<void> {
    await this.client.request('swarm/steer', { sessionId: this.sessionId, text })
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
