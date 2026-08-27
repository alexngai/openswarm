/**
 * Reusable message-boarding harness (docs/01 F1).
 *
 * "Boarding" = the durable mailbox lifecycle: a peer message is queued
 * (durable, before delivery), delivered to the target (wakeup opens a turn /
 * quiet rides the next one), and acked exactly once — queued-minus-delivered
 * is the recovery mailbox. This module boots a live roster of continuable
 * peers and exposes:
 *   - `boardHarness(mode)` — mock (CI-safe) or live (real model) LLM.
 *   - `send(from, to, text, delivery)` — drives one boarding, deterministically
 *     via `mailbox.send()` (the boarding machinery is model-independent).
 *   - Reusable invariant assertions over the durable lead log.
 *
 * The same scenarios and assertions run in both modes, so mock is the fast
 * regression gate and live proves delivery reaches a real model's context.
 */
import { expect } from 'vitest'
import {
  askPeer,
  frameMessage,
  registerSwarmMessaging,
  spawnPeer,
  suppressSettlementTurns,
  type PeerHandle,
  type SwarmMailbox,
  type SwarmMessageDelivery,
  type SwarmMessageSnapshot,
} from '../../src/index'
import * as OpenAiChat from '../../../llm-openai/src/index'
import { bootHarness, type TestHarness } from '../boot'

export type LlmMode = 'mock' | 'live'

/** True when live mode can run (OPENSWARM_LIVE=1 + Azure creds). */
export const liveReady =
  process.env['OPENSWARM_LIVE'] === '1' &&
  process.env['AZURE_API_BASE'] !== undefined &&
  process.env['AZURE_API_KEY'] !== undefined

const LIVE_MODEL = process.env['OPENSWARM_LIVE_MODEL'] ?? 'gpt-5.5'

function azurePlugin() {
  return {
    module: OpenAiChat,
    config: {
      routes: ['openai'],
      baseURL: `${(process.env['AZURE_API_BASE'] ?? '').replace(/\/+$/, '')}/openai/v1`,
      apiKeyEnv: 'AZURE_API_KEY',
      models: [{ id: LIVE_MODEL, contextWindow: 200_000 }],
    },
    provider: 'openai',
    model: LIVE_MODEL,
  }
}

export interface BoardHarness {
  readonly mode: LlmMode
  readonly ctx: any
  readonly lead: TestHarness['lead']['agent']
  readonly mailbox: SwarmMailbox
  readonly roster: Map<string, PeerHandle>
  /** Spawn continuable peers by name and register the messaging tool. */
  spawnPeers(names: string[]): Promise<Record<string, PeerHandle>>
  /** Board one message from → to; resolves once boarding settled (send acked). */
  send(from: string, to: string, text: string, delivery?: SwarmMessageDelivery): Promise<SwarmMessageSnapshot>
  /** Deliver one addressed turn to a peer (carries any pending quiet mail). */
  ask(peer: string, prompt: string): Promise<string>
  /** All durable mailbox events of one type on the lead log. */
  events(type: 'swarm/message/queued' | 'swarm/message/delivered'): any[]
  close(): Promise<void>
}

export async function boardHarness(mode: LlmMode): Promise<BoardHarness> {
  if (mode === 'live' && !liveReady) throw new Error('live mode unavailable (set OPENSWARM_LIVE=1 + Azure creds)')
  const h = await bootHarness(
    { sequence: ['success'], repeatLast: true, successText: 'ack' },
    undefined,
    mode === 'live' ? azurePlugin() : undefined,
  )
  const ctx = (h as any).ctx
  const lead = h.lead.agent
  suppressSettlementTurns(lead)
  const roster = new Map<string, PeerHandle>()
  const mailbox = h.swarm.mailbox(lead, roster)
  registerSwarmMessaging(ctx, roster, mailbox)

  return {
    mode,
    ctx,
    lead,
    mailbox,
    roster,
    async spawnPeers(names) {
      const out: Record<string, PeerHandle> = {}
      for (const name of names) {
        const others = names.filter((n) => n !== name)
        const peer = await spawnPeer(ctx, { name }, {
          parent: lead,
          provider: 'spawn',
          briefing: `You are ${name}, a member of a swarm team. Teammates: ${others.join(', ') || '(none)'}. Messages from teammates arrive as user turns; you can reply to them with the swarm_send_message tool. Acknowledge briefly.`,
        })
        roster.set(name, peer)
        out[name] = peer
      }
      return out
    },
    send(from, to, text, delivery = 'wakeup') {
      return mailbox.send({ from, to, text, delivery })
    },
    async ask(peer, prompt) {
      const handle = roster.get(peer)
      if (handle === undefined) throw new Error(`unknown peer "${peer}"`)
      const result = await askPeer(ctx, lead, handle, prompt, { mailbox })
      return result.text
    },
    events(type) {
      return lead.session.events.filter((e: any) => e.type === type)
    },
    async close() {
      await h.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Reusable invariant assertions — the boarding contract, mode-independent.

/**
 * Every queued message is delivered exactly once and nothing dangles:
 * queued ⊇ delivered, delivered ids unique and all present in queued, and the
 * folded pending set matches queued-minus-delivered.
 */
export function assertBoardingConsistent(h: BoardHarness): void {
  const queued = h.events('swarm/message/queued').map((e) => e.data.message as SwarmMessageSnapshot)
  const delivered = h.events('swarm/message/delivered').map((e) => e.data.messageId as string)
  const queuedIds = new Set(queued.map((m) => m.id))
  // Delivered ids are unique...
  expect(new Set(delivered).size, 'a message was delivered more than once').toBe(delivered.length)
  // ...and every delivered id was really queued first.
  for (const id of delivered) expect(queuedIds.has(id), `delivered ${id} was never queued`).toBe(true)
  // Pending fold = queued minus delivered.
  const pendingIds = new Set(h.mailbox.pending().map((m) => m.id))
  const expectedPending = new Set([...queuedIds].filter((id) => !delivered.includes(id)))
  expect([...pendingIds].sort()).toEqual([...expectedPending].sort())
}

/** Exactly one from→to message was boarded, and it was delivered (not pending). */
export function assertDeliveredOnce(h: BoardHarness, from: string, to: string): SwarmMessageSnapshot {
  const queued = h
    .events('swarm/message/queued')
    .map((e) => e.data.message as SwarmMessageSnapshot)
    .filter((m) => m.from === from && m.to === to)
  expect(queued.length, `expected exactly one ${from}→${to} message`).toBe(1)
  const message = queued[0]!
  const delivered = new Set(h.events('swarm/message/delivered').map((e) => e.data.messageId as string))
  expect(delivered.has(message.id), `${from}→${to} message was never delivered`).toBe(true)
  expect(h.mailbox.pending().some((m) => m.id === message.id), 'delivered message still pending').toBe(false)
  return message
}

/** The framed message text is present in the recipient peer's transcript. */
export function assertRecipientSaw(h: BoardHarness, to: string, message: SwarmMessageSnapshot): void {
  const peer = h.roster.get(to)
  expect(peer, `no peer "${to}"`).toBeDefined()
  const framed = (frameMessage(message)[0] as { type: 'text'; text: string }).text
  const transcript = JSON.stringify(peer!.childId ? h.ctx.agents.get(peer!.childId)?.session.events ?? [] : [])
  // The framed message (id + sender + text) reached the recipient's context.
  expect(transcript.includes(message.text) || transcript.includes(framed.slice(0, 40))).toBe(true)
}
