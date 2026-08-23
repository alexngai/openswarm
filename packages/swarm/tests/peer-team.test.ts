import { afterEach, expect, it } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

it('peer-team works the board to completion, respecting dependencies (end-to-end)', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const result = await h.swarm.runTeam(
    {
      topology: 'peer-team',
      members: [
        { name: 'peer-a', persona: 'You are peer A.' },
        { name: 'peer-b', persona: 'You are peer B.' },
      ],
      tasks: [
        { subject: 'foundation', prompt: 'lay the foundation' },
        { subject: 'walls', prompt: 'raise the walls', blockedBy: [0] },
        { subject: 'garden', prompt: 'plant the garden' },
      ],
    },
    { parent: h.lead.agent },
  )

  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  expect(result.tasks).toHaveLength(3)
  for (const task of result.tasks) {
    expect(task.status).toBe('completed')
    expect(task.result).toContain('done')
    expect(['peer-a', 'peer-b']).toContain(task.owner)
  }
  expect(Object.keys(result.runs)).toHaveLength(3)
  expect(h.mock.requests.length).toBe(3)

  // The durable log proves ordering: 'walls' was claimed only after
  // 'foundation' completed.
  const boardEvents = h.lead.agent.session.events
    .filter((e: any) => e.type === 'swarm/task')
    .map((e: any) => e.data.task)
  const foundationDone = boardEvents.findIndex(
    (t: any) => t.subject === 'foundation' && t.status === 'completed',
  )
  const wallsClaimed = boardEvents.findIndex(
    (t: any) => t.subject === 'walls' && t.status === 'in_progress',
  )
  expect(foundationDone).toBeGreaterThan(-1)
  expect(wallsClaimed).toBeGreaterThan(foundationDone)
})

it('committee runs end-to-end through the real stack', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'committee-says' })
  const result = await h.swarm.runTeam(
    {
      topology: 'committee',
      members: [{ name: 'a' }, { name: 'b' }],
      judge: { name: 'judge' },
      task: 'decide the thing',
    },
    { parent: h.lead.agent },
  )
  if (result.topology !== 'committee') throw new Error('wrong topology')
  expect(result.answers).toHaveLength(2)
  expect(result.synthesis?.stopReason).toBe('completed')
  expect(h.mock.requests.length).toBe(3)
})
