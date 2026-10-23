/**
 * `/swarm` — the human command entry to ctx.swarm (docs/03). The grammar is
 * checked directly; the registration and dispatch go through the REAL dsh
 * command registry over the real spine, so a UI typing `/swarm <task>` is
 * exercised end to end against the scripted mock.
 */
import { afterEach, expect, it, vi } from 'vitest'
import * as Commands from '@deepseek-ai/dsh-commands'
import type { MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'
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
  expect(parseSwarmLine('--wait ship it', defaults)).toEqual({ workers: 3, task: 'ship it', wait: true })
  expect(parseSwarmLine('--workers 2 --wait ship it', defaults)).toEqual({ workers: 2, task: 'ship it', wait: true })
  expect(parseSwarmLine('--waiting room', defaults)).toEqual({ workers: 3, task: '--waiting room' })
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
async function withCommands(successText: string, mock: Partial<MockLlmServerOptions> = {}): Promise<TestHarness> {
  const harness = await bootHarness({ sequence: ['success'], repeatLast: true, successText, ...mock })
  harness.ctx.plugin(plug(Commands))
  harness.ctx.plugin(plug(SwarmCommand), {})
  await new Promise<void>((resolve) => harness.ctx.inject(['commands'], () => resolve()))
  return harness
}

it('registers /swarm, and with --wait runs a coordinator team and returns its synthesis inline', async () => {
  // Every scripted turn returns the same text: as the coordinator's plan it is
  // a two-item numbered list, and as a worker/synthesis answer it is prose.
  h = await withCommands('1. inspect the parser\n2. add the test')

  expect(h.ctx.commands.list(h.lead.agent).map((c) => c.name)).toContain('swarm')

  const execution = await h.ctx.commands.execute(
    h.lead.agent,
    '/swarm --wait --workers 2 refactor the parser',
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

/**
 * Let /swarm track its run as a job (the boot has a registry but no
 * controller), and record what it hands the lead instead of delivering it.
 */
function observe(harness: TestHarness) {
  harness.ctx.jobs.attachController('test')
  const injected: any[] = []
  const followups: string[] = []
  vi.spyOn(harness.lead.agent, 'inject').mockImplementation((m) => void injected.push(m))
  vi.spyOn(harness.lead.agent, 'followup').mockImplementation((m: any) => void followups.push(m.content[0].text))
  return {
    injected,
    followups,
    job: () => harness.ctx.jobs.list(harness.lead.agent)[0],
    injectedText: () => injected.map((m) => m.content[0].text as string),
  }
}

/** The run id a started /swarm names. */
function startedRun(text: string | undefined): string {
  const id = /^Started (run-[0-9a-f]{8}): coordinator with \d+ worker\(s\)\. Follow it in the Swarm tab, or `openswarm attach \1`\.$/.exec(text ?? '')?.[1]
  expect(id, text).toBeDefined()
  return id!
}

it('by default /swarm returns the run id at once; on settle the synthesis is injected and the row finishes', async () => {
  // Slow turns, so the run is still going when the command returns.
  h = await withCommands('1. inspect the parser\n2. add the test', { sequence: ['slow_success'], chunkSize: 4, chunkDelayMs: 20 })
  const lead = observe(h)

  const request = new AbortController()
  const execution = await h.ctx.commands.execute(h.lead.agent, '/swarm --workers 2 refactor the parser', [], request.signal)
  expect(execution?.result.kind).toBe('success')
  const runId = startedRun(execution?.result.text)
  const run = h.swarm.live(runId)!
  // The run outlives the UI request that started it.
  request.abort()
  expect(h.swarm.view(runId).run.status).toBe('running')
  expect(lead.job()).toMatchObject({ status: 'running', label: '/swarm --workers 2 refactor the parser' })
  expect(lead.injected).toEqual([])
  // The session was blank, so the start message is posted as a turn and the Swarm tab appears.
  expect(lead.followups).toEqual([execution?.result.text])

  await run.result
  await vi.waitFor(() => expect(lead.injected).toHaveLength(1))
  expect(lead.injected[0].source).toMatchObject({ kind: 'plugin', plugin: 'openswarm-swarm', form: 'notice' })
  expect(lead.injectedText()[0]).toMatch(new RegExp(`^/swarm run ${runId} settled\\.\\n\\nSwarm finished: 2 subtask\\(s\\) across 2 worker\\(s\\)\\.`))
  // Reported, so tool-jobs posts no completion notice that would wake the lead.
  expect(lead.job()).toMatchObject({ status: 'completed', detail: '2 subtask(s) across 2 worker(s)', reported: true })
  // plan + 2 subtasks + synthesis; no lead turn.
  expect(h.mock.requests.length).toBe(4)
  expect(lead.followups).toHaveLength(1)
}, 60_000)

it('a detached run that fails injects the failure and fails its row', async () => {
  h = await withCommands('no numbered list here')
  const lead = observe(h)
  const execution = await h.ctx.commands.execute(h.lead.agent, '/swarm do it', [], new AbortController().signal)
  const runId = startedRun(execution?.result.text)
  await vi.waitFor(() => expect(lead.injected).toHaveLength(1))
  expect(lead.injectedText()[0]).toBe(`/swarm run ${runId} settled.\n\nswarm run failed: coordinator produced no parseable numbered subtasks`)
  expect(lead.job()).toMatchObject({ status: 'failed', detail: 'coordinator produced no parseable numbered subtasks' })
  expect(h.swarm.view(runId).run.status).toBe('failed')
})

it('killing the job row cancels a detached run', async () => {
  // Every model turn hangs, so only the kill ends the run.
  h = await withCommands('unused', { sequence: ['stall'] })
  const lead = observe(h)
  const execution = await h.ctx.commands.execute(h.lead.agent, '/swarm hold', [], new AbortController().signal)
  const run = h.swarm.live(startedRun(execution?.result.text))!
  expect(h.ctx.jobs.kill(lead.job()!.id, h.lead.agent)).toBe('requested')
  await expect(run.result).rejects.toThrow()
  expect(h.swarm.view(run.id).run.status).toBe('failed')
  await vi.waitFor(() => expect(lead.job()).toMatchObject({ status: 'killed' }))
  await vi.waitFor(() => expect(lead.injectedText()[0]).toContain('swarm run failed'))
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
