/**
 * PROBE: can dsh reopen a session that hosted a swarm board?
 *
 * The board and mailbox append `swarm/*` events to the lead's session log,
 * which for a peer-team run is the caller's own agent. dsh persistence
 * refuses to load a log holding an event type outside its built-in list
 * unless the event is marked `ignorable`, and `session.append` never marks
 * one (docs/05 §11). This pins the consequence: a plain session reopens, and
 * the same session after one board write does not. It flips the day dsh
 * accepts plugin event types; until then the run journal lives in its own
 * file (docs/05 D1).
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** One scripted model turn, so the log holds dsh's own events. */
async function oneTurn(harness: TestHarness): Promise<void> {
  const agent = harness.lead.agent
  const ended = new Promise<void>((resolve) => {
    const off = harness.ctx.on('session/event', (session: unknown, event: { type: string }) => {
      if (session !== agent.session || event.type !== 'turn/end') return
      off()
      resolve()
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await ended
}

/** Flush, drop the live agent, and resume the session from persistence. */
async function reopen(harness: TestHarness) {
  const session = harness.lead.agent.session
  await harness.ctx.sessions.flush(session)
  await harness.lead.dispose()
  const resumed = await harness.ctx.agents.resume({
    resumeSessionId: session.id,
    agentOptions: { provider: 'deepseek-official', model: 'mock-model' },
  })
  await resumed.dispose()
}

it('a session holding only dsh events reopens', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'ok' })
  await oneTurn(h)
  await expect(reopen(h)).resolves.toBeUndefined()
})

it('the same session after one board write does NOT reopen', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'ok' })
  await oneTurn(h)
  await h.swarm.board(h.lead.agent).create({ subject: 's', prompt: 'p' })
  await expect(reopen(h)).rejects.toThrow(/swarm\/task.*not marked ignorable/)
})
