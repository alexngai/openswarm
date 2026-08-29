/**
 * Message-boarding integration suite (docs/01 F1), driven by the reusable
 * board-harness. Runs in `mock` mode always (CI-safe regression gate) and in
 * `live` mode against real gpt-5.5 when OPENSWARM_LIVE=1 — the SAME scenarios
 * and the SAME durable-invariant assertions in both, so live proves boarding
 * reaches a real model's context without duplicating the checks.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertBoardingConsistent,
  assertDeliveredOnce,
  assertRecipientSaw,
  boardHarness,
  liveReady,
  type BoardHarness,
  type LlmMode,
} from './support/board-harness'

const MODES: LlmMode[] = liveReady ? ['mock', 'live'] : ['mock']

describe.each(MODES)('message boarding [%s]', (mode) => {
  let h: BoardHarness | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })

  it('wakeup boarding: queue → deliver → ack, recipient sees it', async () => {
    h = await boardHarness(mode)
    await h.spawnPeers(['alice', 'bob'])

    const sent = await h.send('alice', 'bob', 'the codeword is FALCON')
    // Durable pair written, nothing pending, delivered exactly once.
    expect(h.events('swarm/message/queued')).toHaveLength(1)
    assertBoardingConsistent(h)
    const message = assertDeliveredOnce(h, 'alice', 'bob')
    expect(message.id).toBe(sent.id)
    // The wakeup carried the message into bob's live context.
    await assertRecipientSaw(h, 'bob', message)
  })

  it('quiet boarding: stays queued until the next addressed turn carries it', async () => {
    h = await boardHarness(mode)
    await h.spawnPeers(['alice', 'bob'])

    await h.send('alice', 'bob', 'quiet note: prefer tabs', 'quiet')
    // Quiet never delivers immediately — durably queued, still pending.
    expect(h.events('swarm/message/queued')).toHaveLength(1)
    expect(h.events('swarm/message/delivered')).toHaveLength(0)
    expect(h.mailbox.pending()).toHaveLength(1)

    // Bob's next addressed turn drains the quiet mail. Assert the SPECIFIC
    // alice→bob message boarded (a live bob may autonomously send its own
    // reply, so the global mailbox is not necessarily empty).
    await h.ask('bob', 'Acknowledge you are ready.')
    assertBoardingConsistent(h)
    const note = assertDeliveredOnce(h, 'alice', 'bob')
    expect(h.mailbox.pending().some((m) => m.id === note.id)).toBe(false)
  })

  it('unknown recipient is rejected before anything is queued', async () => {
    h = await boardHarness(mode)
    await h.spawnPeers(['alice'])
    await expect(h.send('alice', 'ghost', 'hi')).rejects.toThrow(/unknown peer/)
    expect(h.events('swarm/message/queued')).toHaveLength(0)
    assertBoardingConsistent(h)
  })

  it('multiple boardings all deliver exactly once with no dangling state', async () => {
    h = await boardHarness(mode)
    await h.spawnPeers(['alice', 'bob', 'carol'])

    await h.send('alice', 'bob', 'first')
    await h.send('carol', 'bob', 'second')
    await h.send('bob', 'alice', 'third')

    // At least our three boardings (a live recipient may add its own replies).
    expect(h.events('swarm/message/queued').length).toBeGreaterThanOrEqual(3)
    assertBoardingConsistent(h)
    // Each of the three we sent was delivered exactly once with no dangling state.
    assertDeliveredOnce(h, 'alice', 'bob')
    assertDeliveredOnce(h, 'carol', 'bob')
    assertDeliveredOnce(h, 'bob', 'alice')
  })
})
