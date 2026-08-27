import { afterEach, expect, it } from 'vitest'
import {
  askPeer,
  nextTurnEnd,
  registerSwarmMessaging,
  spawnPeer,
  suppressSettlementTurns,
  type PeerHandle,
} from '../src/index'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function spawnPair(h: TestHarness) {
  const ctx = (h as any).ctx
  suppressSettlementTurns(h.lead.agent)
  const roster = new Map<string, PeerHandle>()
  const mailbox = h.swarm.mailbox(h.lead.agent, roster)
  registerSwarmMessaging(ctx, roster, mailbox)
  const a = await spawnPeer(ctx, { name: 'peer-a' }, {
    parent: h.lead.agent,
    provider: 'spawn',
    briefing: 'You are peer-a. Acknowledge.',
  })
  const b = await spawnPeer(ctx, { name: 'peer-b' }, {
    parent: h.lead.agent,
    provider: 'spawn',
    briefing: 'You are peer-b. Acknowledge.',
  })
  roster.set('peer-a', a)
  roster.set('peer-b', b)
  return { ctx, a, b, mailbox }
}

function leadEvents(h: TestHarness, type: string): any[] {
  return h.lead.agent.session.events.filter((e: any) => e.type === type)
}

it('wakeup send queues durably, wakes the target, and acks delivery', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'ack' })
  const { ctx, b, mailbox } = await spawnPair(h)

  const turnDone = nextTurnEnd(ctx, () => b.childId)
  const message = await mailbox.send({ from: 'peer-a', to: 'peer-b', text: 'the walls are ready' })

  // Durable queued + delivered pair in the lead log, and nothing pending.
  expect(leadEvents(h, 'swarm/message/queued')).toHaveLength(1)
  expect(leadEvents(h, 'swarm/message/delivered')).toHaveLength(1)
  expect(mailbox.pending()).toHaveLength(0)

  // The wakeup opened a turn for peer-b carrying the framed message.
  const session = await turnDone
  const log = JSON.stringify(session.events)
  expect(log).toContain(`Swarm message ${message.id} from peer-a`)
  expect(log).toContain('the walls are ready')
})

it('quiet send starts no turn and lands as context on the next addressed turn', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'ok' })
  const { ctx, b, mailbox } = await spawnPair(h)
  const requestsBefore = h.mock.requests.length

  // Quiet never opens a turn and never delivers immediately: continuable
  // activations are transient, so it stays durably queued until it rides a
  // waking delivery.
  await mailbox.send({ from: 'peer-a', to: 'peer-b', text: 'psst — context only', delivery: 'quiet' })
  await new Promise((r) => setTimeout(r, 50))
  expect(h.mock.requests.length).toBe(requestsBefore)
  expect(leadEvents(h, 'swarm/message/queued')).toHaveLength(1)
  expect(mailbox.pending()).toHaveLength(1)

  // The next addressed turn carries the quiet mail in front of the prompt.
  await askPeer(ctx, h.lead.agent, b, 'status report please', { mailbox })
  expect(mailbox.pending()).toHaveLength(0)
  const lastBody = JSON.stringify(h.mock.requests.at(-1)?.body)
  expect(lastBody).toContain('psst — context only')
  expect(lastBody).toContain('status report please')
})

it('a member sends through the swarm_send_message tool (model-driven, end-to-end)', async () => {
  h = await bootHarness({
    // peer-a brief, peer-b brief, then peer-a's addressed turn calls the tool,
    // continues after the result, and peer-b's wakeup turn follows.
    sequence: ['success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'swarm_send_message',
    toolArguments: JSON.stringify({ to: 'peer-b', message: 'heads up from a tool call' }),
  })
  const { ctx, a, b } = await spawnPair(h)

  const bTurn = nextTurnEnd(ctx, () => b.childId)
  const result = await askPeer(ctx, h.lead.agent, a, 'notify your teammate')
  expect(result.stopReason).toBe('completed')

  // Mailbox committed durably in the lead log.
  expect(leadEvents(h, 'swarm/message/queued')).toHaveLength(1)
  expect(leadEvents(h, 'swarm/message/delivered')).toHaveLength(1)
  // Peer-b's wakeup turn saw the framed message.
  const bLog = JSON.stringify((await bTurn).events)
  expect(bLog).toContain('heads up from a tool call')
  expect(bLog).toContain('from peer-a')
})

it('messaging peer-team completes the board with continuable peers', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const result = await h.swarm.runTeam(
    {
      topology: 'peer-team',
      messaging: true,
      members: [{ name: 'peer-a' }, { name: 'peer-b' }],
      tasks: [
        { subject: 'one', prompt: 'do one' },
        { subject: 'two', prompt: 'do two' },
      ],
    },
    { parent: h.lead.agent },
  )
  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  expect(result.tasks).toHaveLength(2)
  for (const task of result.tasks) expect(task.status).toBe('completed')
  // Two briefing turns + two task turns.
  expect(h.mock.requests.length).toBe(4)
})

it('framePendingQuiet reserves in-flight mail so concurrent drains do not double-deliver', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'x' })
  const { b, mailbox } = await spawnPair(h)
  await mailbox.send({ from: 'peer-a', to: 'peer-b', text: 'quiet-note', delivery: 'quiet' })

  // Two concurrent drains for peer-b: the first reserves the message, the
  // second sees it in-flight and gets nothing.
  const first = mailbox.framePendingQuiet('peer-b')
  const second = mailbox.framePendingQuiet('peer-b')
  expect(first.blocks.length).toBeGreaterThan(0)
  expect(second.blocks).toHaveLength(0)

  // Releasing the first returns the message to a later drain.
  first.release()
  const third = mailbox.framePendingQuiet('peer-b')
  expect(third.blocks.length).toBeGreaterThan(0)
  // Acking marks it delivered; nothing pending, no further drain yields it.
  await third.ack()
  expect(mailbox.pending()).toHaveLength(0)
  expect(mailbox.framePendingQuiet('peer-b').blocks).toHaveLength(0)
  void b
})
