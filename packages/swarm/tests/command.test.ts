/**
 * `/swarm` — the human command entry to ctx.swarm (docs/03). The grammar is
 * checked directly; the registration and dispatch go through the REAL dsh
 * command registry over the real spine, so a UI typing `/swarm <task>` is
 * exercised end to end against the scripted mock.
 */
import { afterEach, expect, it } from 'vitest'
import * as Commands from '@deepseek-ai/dsh-commands'
import * as SwarmCommand from '../src/command'
import { parseSwarmLine, surfaceOnBlankSession } from '../src/command'
import { bootHarness, type TestHarness } from './boot'

const plug = (m: unknown): any => (m as any).default ?? m
const defaults = { workers: 3, maxWorkers: 8 }

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

it('parses the task, the optional worker count, and rejects bad lines', () => {
  expect(parseSwarmLine(' refactor the parser ', defaults)).toEqual({
    workers: 3,
    task: 'refactor the parser',
  })
  expect(parseSwarmLine('--workers 5 ship it', defaults)).toEqual({ workers: 5, task: 'ship it' })
  expect(parseSwarmLine('--workers=2 ship it', defaults)).toEqual({ workers: 2, task: 'ship it' })
  // A task that merely mentions workers is a task, not a flag.
  expect(parseSwarmLine('add --workers to the CLI', defaults)).toEqual({
    workers: 3,
    task: 'add --workers to the CLI',
  })
  expect(parseSwarmLine('', defaults)).toMatchObject({ error: expect.stringContaining('No task') })
  expect(parseSwarmLine('--workers 5', defaults)).toMatchObject({
    error: expect.stringContaining('No task'),
  })
  expect(parseSwarmLine('--workers 0 x', defaults)).toMatchObject({
    error: expect.stringContaining('1-8'),
  })
  expect(parseSwarmLine('--workers 99 x', defaults)).toMatchObject({
    error: expect.stringContaining('1-8'),
  })
})

/** Mount the real command registry and our command over a booted harness. */
async function withCommands(successText: string): Promise<TestHarness> {
  const harness = await bootHarness({ sequence: ['success'], repeatLast: true, successText })
  harness.ctx.plugin(plug(Commands))
  harness.ctx.plugin(plug(SwarmCommand), {})
  await new Promise<void>((resolve) => harness.ctx.inject(['commands'], () => resolve()))
  return harness
}

it('registers /swarm and runs a coordinator team through the command registry', async () => {
  // Every scripted turn returns the same text: as the coordinator's plan it is
  // a two-item numbered list, and as a worker/synthesis answer it is prose.
  h = await withCommands('1. inspect the parser\n2. add the test')

  expect(h.ctx.commands.list(h.lead.agent).map((c) => c.name)).toContain('swarm')

  const execution = await h.ctx.commands.execute(
    h.lead.agent,
    '/swarm --workers 2 refactor the parser',
    [],
    new AbortController().signal,
  )
  expect(execution?.result.kind, JSON.stringify(execution?.result)).toBe('success')
  const text = execution!.result.text!
  expect(text).toContain('2 subtask(s) across 2 worker(s)')
  expect(text).toContain('[worker-1] inspect the parser')
  expect(text).toContain('[worker-2] add the test')
  // plan + 2 subtasks + synthesis = 4 model turns really reached the mock.
  expect(h.mock.requests.length).toBe(4)
}, 60_000)

it('reports a bad line as a command error without running a team', async () => {
  h = await withCommands('unused')
  const execution = await h.ctx.commands.execute(
    h.lead.agent,
    '/swarm',
    [],
    new AbortController().signal,
  )
  expect(execution?.result.kind).toBe('error')
  expect(h.mock.requests.length).toBe(0)
})

/** A stand-in agent exposing only what the blank-session check reads. */
function fakeAgent(events: { type: string }[]) {
  const followups: string[] = []
  const agent = {
    session: { events },
    followup: (m: any) => followups.push(m.content?.[0]?.text ?? ''),
  }
  return { agent: agent as never, followups }
}

it('a blank session gets the result as a follow-up turn, so it is rendered at all', () => {
  // No turn/start: upstream's own blankness fold, which command lifecycle
  // records deliberately never satisfy.
  const { agent, followups } = fakeAgent([{ type: 'command/run' }, { type: 'command/done' }])
  surfaceOnBlankSession(agent, 'Swarm finished: 2 subtask(s)')
  expect(followups).toEqual(['Swarm finished: 2 subtask(s)'])
})

it('an established session gets no follow-up — the command result already renders inline', () => {
  const { agent, followups } = fakeAgent([
    { type: 'user/message' },
    { type: 'turn/start' },
    { type: 'turn/end' },
  ])
  surfaceOnBlankSession(agent, 'Swarm finished: 2 subtask(s)')
  expect(followups).toEqual([])
})
