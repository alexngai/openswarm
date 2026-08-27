/**
 * Continuable peer members: spawn, addressed turns, and the model-facing
 * `swarm_send_message` capability. Continuable activations are TRANSIENT —
 * the continuation manager disposes a resident agent once its turn settles
 * and cold-resumes a fresh one on the next waking delivery — so peers are
 * addressed by durable child id, never by a captured Agent, and child-scoped
 * capabilities install through the activation setup registry so every
 * re-activation gets them again.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { SwarmMailbox } from './mailbox'
import type { MemberRunResult, MemberSpec, PeerHandle } from './types'

export interface SpawnPeerOptions {
  parent: Agent
  provider: string
  briefing: string
  signal?: AbortSignal
}

/**
 * Suppress the lead's reactive model turns for child-settlement notices.
 * The continuation manager wakes the parent whenever a continuable child
 * settles a turn; under a service-driven lead (our topologies) that reactive
 * model call is pure cost. Rejecting the claim closes a durable turn with no
 * step — the notice stays in the log, the model is never called. Leads whose
 * own model orchestrates the team should NOT install this.
 */
export function suppressSettlementTurns(lead: Agent): () => void {
  return lead.ctx.on('agent/pre-step', (payload: any, next: () => Promise<any>) => {
    if (
      payload.agent.id === lead.id &&
      payload.messages.length > 0 &&
      payload.messages.every((m: any) => m.source?.kind === 'subagent-settled')
    ) {
      return Promise.resolve({ kind: 'reject' })
    }
    return next()
  })
}

/**
 * Resolve on the first `turn/end` for `sessionId` observed after subscribing,
 * with the live session that emitted it (activations swap session instances;
 * the id is the stable identity).
 */
export function nextTurnEnd(
  ctx: Context,
  sessionId: () => SessionId | undefined,
): Promise<{ events: readonly any[] }> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session: any, event: any) => {
      if (event.type !== 'turn/end') return
      if (session.id !== sessionId()) return
      dispose()
      resolve(session)
    })
  })
}

/** Spawn one continuable peer and wait out its briefing turn. */
export async function spawnPeer(
  ctx: Context,
  member: MemberSpec,
  options: SpawnPeerOptions,
): Promise<PeerHandle> {
  const text =
    member.persona === undefined ? options.briefing : `${member.persona}\n\n${options.briefing}`
  let childId: SessionId | undefined
  const briefingDone = nextTurnEnd(ctx, () => childId)
  const start = await ctx.subagents.startContinuable({
    provider: options.provider,
    label: member.name,
    request: {
      prompt: [{ type: 'text', text }],
      parent: options.parent,
      ...(member.agentOptions === undefined ? {} : { agentOptions: member.agentOptions }),
    },
    signal: options.signal ?? new AbortController().signal,
  })
  childId = start.childId
  await briefingDone
  return { name: member.name, childId: start.childId }
}

function textOf(output: readonly any[]): string {
  return output
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Deliver one addressed prompt to a peer and return that turn's output.
 * Pending quiet mail for the peer rides along when a mailbox is supplied.
 */
export async function askPeer(
  ctx: Context,
  lead: Agent,
  peer: PeerHandle,
  prompt: string,
  options?: { signal?: AbortSignal; mailbox?: SwarmMailbox },
): Promise<MemberRunResult> {
  const childId = peer.childId
  if (childId === undefined) throw new Error(`peer "${peer.name}" is not an in-process peer`)
  const prelude = options?.mailbox?.framePendingQuiet(peer.name)
  const turnDone = nextTurnEnd(ctx, () => childId)
  try {
    await ctx.subagents.followup(
      lead,
      childId,
      [...(prelude?.blocks ?? []), { type: 'text', text: prompt }],
      {
        source: { kind: 'plugin', plugin: 'openswarm-swarm' } as never,
        signal: options?.signal ?? new AbortController().signal,
      },
    )
  } catch (error) {
    prelude?.release()
    throw error
  }
  await prelude?.ack()
  const session = await turnDone
  const output = finalAssistantOutput(session.events as never) ?? []
  return {
    member: peer.name,
    runId: childId,
    output,
    text: textOf(output),
    stopReason: 'completed',
  }
}

/**
 * Install `swarm_send_message` into every continuable child activation while
 * registered. Sender identity resolves from the executing agent's id against
 * the roster, so the tool grants no cross-member authority; a non-roster
 * child calling it fails loud. Returns the registration undo.
 */
export function registerSwarmMessaging(
  ctx: Context,
  roster: Map<string, PeerHandle>,
  mailbox: SwarmMailbox,
): () => void {
  return ctx.subagents.registerContinuableSetup((childCtx: Context) =>
    childCtx.tools.register(
      defineTool({
        name: 'swarm_send_message',
        description:
          'Send a message to a teammate by name. wakeup delivery starts a turn for them; quiet delivery lands as context the next time they run.',
        parameters: {
          to: { type: 'string', required: true, description: 'Teammate name from your briefing.' },
          message: { type: 'string', required: true, description: 'The message text.' },
          delivery: {
            type: 'string',
            enum: ['wakeup', 'quiet'],
            description: 'Delivery mode; defaults to wakeup.',
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: { messageId: { type: 'string', required: true } },
            additionalProperties: false,
          },
          render: (_args: unknown, value: any) => [
            { type: 'text', text: `sent (id ${value.messageId})` },
          ],
        },
        async execute(args: any, exec: any) {
          const senderId = exec.agent?.id
          const sender = [...roster.values()].find((p) => p.childId === senderId)
          if (sender === undefined) throw new Error('swarm_send_message caller is not a team peer')
          const message = await mailbox.send({
            from: sender.name,
            to: args.to,
            text: args.message,
            ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
          })
          return { messageId: message.id }
        },
      } as never),
    ),
  )
}
