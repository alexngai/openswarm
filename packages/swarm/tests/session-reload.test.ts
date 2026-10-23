/**
 * Can dsh reopen a session that hosted a swarm board?
 *
 * dsh persistence refuses to load a log holding an event type outside its
 * built-in list unless the event is marked `ignorable`, and `session.append`
 * never marks one (docs/05 §11). The board and mailbox used to append
 * `swarm/*` events to the lead's session log — for a peer-team run, the
 * caller's own agent — so a session that hosted a board could never resume.
 * They now write the run's own journal (docs/05 D1, A3, A4); this pins the
 * fix: a session reopens after parenting a run that wrote a board.
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

it('the same session after parenting a peer-team run still reopens', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'ok' })
  await oneTurn(h)
  await h.swarm.runTeam(
    { topology: 'peer-team', members: [{ name: 'm' }], tasks: [{ subject: 's', prompt: 'p' }] },
    { parent: h.lead.agent },
  )
  await expect(reopen(h)).resolves.toBeUndefined()
})
