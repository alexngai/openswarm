import { afterEach, expect, it } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const WORKER = { name: 'worker', persona: 'You draft solutions.' }
const CRITIC = { name: 'critic', persona: 'You review drafts.' }

it('critic-loop approves on the first round when the critic says APPROVED', async () => {
  // The mock returns the same text for every success; 'APPROVED' satisfies the
  // critic-verdict parse, and the worker draft's content is irrelevant to flow.
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'APPROVED' })
  const result = await h.swarm.runTeam(
    { topology: 'critic-loop', worker: WORKER, critic: CRITIC, task: 'write the doc' },
    { parent: h.lead.agent },
  )

  if (result.topology !== 'critic-loop') throw new Error('wrong topology')
  expect(result.approved).toBe(true)
  expect(result.rounds).toBe(1)
  expect(result.history).toHaveLength(1)
  // Exactly two runs: one draft, one verdict.
  expect(h.mock.requests.length).toBe(2)
})

it('critic-loop threads feedback into revisions and stops at maxRounds unapproved', async () => {
  h = await bootHarness({
    sequence: ['success'],
    repeatLast: true,
    successText: 'REVISE: add error handling',
  })
  const result = await h.swarm.runTeam(
    { topology: 'critic-loop', worker: WORKER, critic: CRITIC, task: 'write the doc', maxRounds: 2 },
    { parent: h.lead.agent },
  )

  if (result.topology !== 'critic-loop') throw new Error('wrong topology')
  expect(result.approved).toBe(false)
  expect(result.rounds).toBe(2)
  expect(result.history).toHaveLength(2)
  // worker, critic, worker, critic.
  expect(h.mock.requests.length).toBe(4)
  // Round-2 worker prompt carries the critic's feedback and the previous draft.
  const round2Worker = JSON.stringify(h.mock.requests[2]?.body)
  expect(round2Worker).toContain('Reviewer feedback')
  expect(round2Worker).toContain('REVISE: add error handling')
  expect(result.final.member).toBe('worker')
})
