/**
 * The intent header (docs/05 §6.1, A7): rendered once and prepended to every
 * member prompt a run sends — the run's intent, or a peer-team task's own.
 * A run without one sends its prompts unchanged (every other suite).
 */
import { afterEach, expect, it } from 'vitest'
import { coordinatorSpec, renderIntent, type Intent } from '../src/index'
import { withIntent } from '../src/topologies'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** Every model request body the mock saw, as JSON text. */
const bodies = () => h!.mock.requests.map((r) => JSON.stringify(r.body))
/** `text` as it appears inside a JSON string. */
const json = (text: string) => JSON.stringify(text).slice(1, -1)

it('renders an intent as a short markdown header, leaving out empty lists', () => {
  expect(renderIntent({ purpose: 'p', endState: 'e', constraints: ['c1', 'c2'], preferences: ['pr'] })).toBe(
    '## Intent\nPurpose: p\nEnd state (checkable): e\nConstraints:\n- c1\n- c2\nPreferences:\n- pr',
  )
  expect(renderIntent({ purpose: 'p', endState: 'e', constraints: [] })).toBe('## Intent\nPurpose: p\nEnd state (checkable): e')
  expect(withIntent('go', { purpose: 'p', endState: 'e' })).toBe('## Intent\nPurpose: p\nEnd state (checkable): e\n\ngo')
  expect(withIntent('go', undefined)).toBe('go')
})

it("every member request of a run carries the run's intent, the plan and synthesis included", async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: '1. first\n2. second' })
  const intent: Intent = { purpose: 'ship the parser', endState: 'npm test passes', constraints: ['no new deps'] }
  const run = await h.swarm.start({ ...coordinatorSpec('refactor the parser', 2), intent }, { parent: h.lead.agent })
  await run.result
  // plan + 2 subtasks + synthesis
  expect(bodies()).toHaveLength(4)
  for (const body of bodies()) expect(body).toContain(json(`${renderIntent(intent)}\n\n`))
  expect(h.swarm.view(run.id).recap[0]).toMatch(/^#0 run started: coordinator \(pid \d+ on .+\): ship the parser$/)
})

it("a peer-team task's own intent replaces the run's for that task only, and is on its board snapshot", async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const runIntent: Intent = { purpose: 'tidy the repo', endState: 'lint is clean' }
  const own: Intent = { purpose: 'fix the parser', endState: 'parser tests pass' }
  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      members: [{ name: 'm' }],
      tasks: [
        { subject: 'alpha', prompt: 'do alpha', intent: own },
        { subject: 'beta', prompt: 'do beta' },
      ],
      intent: runIntent,
    },
    { parent: h.lead.agent },
  )
  await run.result
  expect(h.swarm.view(run.id).tasks.map((t) => t.intent)).toEqual([own, undefined])
  const alpha = bodies().find((b) => b.includes('do alpha'))!
  const beta = bodies().find((b) => b.includes('do beta'))!
  expect(alpha).toContain(json(`${renderIntent(own)}\n\ndo alpha`))
  expect(alpha).not.toContain('tidy the repo')
  expect(beta).toContain(json(`${renderIntent(runIntent)}\n\ndo beta`))
})

it('a messaging peer-team delivers each task turn under its intent', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const intent: Intent = { purpose: 'tidy the repo', endState: 'lint is clean' }
  await h.swarm.runTeam(
    { topology: 'peer-team', messaging: true, members: [{ name: 'm' }], tasks: [{ subject: 'alpha', prompt: 'do alpha' }], intent },
    { parent: h.lead.agent },
  )
  expect(bodies().find((b) => b.includes('do alpha'))).toContain(json(`${renderIntent(intent)}\n\ndo alpha`))
})
