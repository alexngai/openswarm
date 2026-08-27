import { afterEach, expect, it } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

it('fanout runs one subagent per task and collects every result', async () => {
  h = await bootHarness({
    sequence: ['success'],
    repeatLast: true,
    successText: 'fanout-response',
  })
  const result = await h.swarm.runTeam(
    {
      topology: 'fanout',
      members: [
        { name: 'researcher', persona: 'You research.' },
        { name: 'implementer', persona: 'You implement.' },
        { name: 'tester', persona: 'You test.' },
      ],
      tasks: [
        { member: 'researcher', prompt: 'research the thing' },
        { member: 'implementer', prompt: 'implement the thing' },
        { member: 'tester', prompt: 'test the thing' },
      ],
    },
    { parent: h.lead.agent },
  )

  if (result.topology !== 'fanout') throw new Error('wrong topology')
  expect(result.results).toHaveLength(3)
  for (const r of result.results) {
    expect(r.stopReason).toBe('completed')
    expect(r.text).toContain('fanout-response')
  }
  expect(result.results.map((r) => r.member)).toEqual(['researcher', 'implementer', 'tester'])
  // Three model requests reached the mock — one per member run.
  expect(h.mock.requests.length).toBe(3)
  // Each member saw its own prompt with its persona embedded.
  const bodies = h.mock.requests.map((r) => JSON.stringify(r.body))
  expect(bodies.some((b) => b.includes('research the thing') && b.includes('You research.'))).toBe(true)
  expect(bodies.some((b) => b.includes('implement the thing') && b.includes('You implement.'))).toBe(true)
  expect(bodies.some((b) => b.includes('test the thing') && b.includes('You test.'))).toBe(true)
})

it('fanout rejects a task naming an unknown member', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'x' })
  await expect(
    h.swarm.runTeam(
      { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'ghost', prompt: 'p' }] },
      { parent: h.lead.agent },
    ),
  ).rejects.toThrow('unknown member "ghost"')
})

it('fanout members can override the model route per member (heterogeneous team)', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'ok' })
  await h.swarm.runTeam(
    {
      topology: 'fanout',
      members: [
        { name: 'small', agentOptions: { model: 'mock-model-small' } },
        { name: 'default' },
      ],
      tasks: [
        { member: 'small', prompt: 'cheap task' },
        { member: 'default', prompt: 'normal task' },
      ],
    },
    { parent: h.lead.agent },
  )
  const models = h.mock.requests.map((r) => (r.body as { model?: string }).model)
  expect(models).toContain('mock-model-small')
  expect(models).toContain('mock-model')
})
