/** The Swarm tab's pure view-model helpers (docs/05 A9). */
import { expect, it } from 'vitest'
import { age, memberNames, newestFirst, openQuestions, pickRun, resultText, runLabel, sortTasks, startArgs } from '../src/model.js'

const run = (id: string, parentSessionId: string, startedAt: number) => ({ id, parentSessionId, startedAt, status: 'running', topology: 'peer-team' })

it('picks the newest run of this session, else the newest run', () => {
  const runs = [run('a', 's1', 1), run('b', 's1', 3), run('c', 's2', 5)]
  expect(pickRun(runs, 's1')?.id).toBe('b')
  expect(pickRun(runs, 'other')?.id).toBe('c')
  expect(pickRun([], 's1')).toBeUndefined()
  expect(newestFirst(runs).map((r) => r.id)).toEqual(['c', 'b', 'a'])
})

it('names members from the spec, then task owners, once each', () => {
  const tasks = [{ id: 't1', owner: 'bob' }, { id: 't2', owner: 'carol' }, { id: 't3' }]
  const peer = { run: { spec: { topology: 'peer-team', members: [{ name: 'alice' }, { name: 'bob' }] } }, tasks }
  expect(memberNames(peer)).toEqual(['alice', 'bob', 'carol'])
  const critic = { run: { spec: { topology: 'critic-loop', worker: { name: 'w' }, critic: { name: 'c' } } }, tasks: [] }
  expect(memberNames(critic)).toEqual(['w', 'c'])
  const pipeline = { run: { spec: { topology: 'pipeline', stages: [{ member: { name: 'p1' } }] } }, tasks: [] }
  expect(memberNames(pipeline)).toEqual(['p1'])
  expect(memberNames({ run: {}, tasks: [] })).toEqual([])
})

it('orders tasks by id numerically and keeps only open questions', () => {
  expect(sortTasks([{ id: 't10' }, { id: 't2' }, { id: 't1' }]).map((t) => t.id)).toEqual(['t1', 't2', 't10'])
  const view = { questions: [{ id: 'q-1', status: 'answered' }, { id: 'q-2', status: 'open' }] }
  expect(openQuestions(view).map((q) => q.id)).toEqual(['q-2'])
})

it('formats ages and picker lines', () => {
  expect(age(0, 42_000)).toBe('42s')
  expect(age(0, 5 * 60_000)).toBe('5m')
  expect(age(0, 3 * 3_600_000)).toBe('3h')
  expect(age(0, 2 * 86_400_000)).toBe('2d')
  expect(runLabel(run('run-1', 's', 0), 60_000)).toBe('run-1 · running · peer-team · 1m')
})

it('builds start args from the form, omitting blank worktrees', () => {
  expect(startArgs('{"topology":"fanout"}', '  ')).toEqual({ spec: { topology: 'fanout' } })
  expect(startArgs('{"topology":"fanout"}', '{"repoRoot":"/r"}')).toEqual({
    spec: { topology: 'fanout' },
    worktrees: { repoRoot: '/r' },
  })
  expect(() => startArgs('{nope', '')).toThrow(/^spec: /)
  expect(() => startArgs('[]', '')).toThrow('spec: must be a JSON object')
  expect(() => startArgs('{}', 'null')).toThrow('worktrees: must be a JSON object')
})

it("shows a finished run's result: the synthesis or final text, else each output under its label", () => {
  const finished = (result?: object) => ({ status: 'finished', result })
  expect(resultText(finished({ topology: 'coordinator', synthesis: { member: 'c', text: 'synth' } }))).toBe('synth')
  expect(resultText(finished({ topology: 'cascade', final: { member: 't', text: 'last' } }))).toBe('last')
  const fanout = { topology: 'fanout', results: [{ member: 'a', text: 'x' }, { member: 'b', text: 'y' }] }
  expect(resultText(finished(fanout))).toBe('--- a ---\nx\n\n--- b ---\ny')
  expect(resultText(finished({ topology: 'committee', answers: [{ member: 'a', text: 'x' }] }))).toBe('--- a ---\nx')
  const peers = { topology: 'peer-team', tasks: [{ id: 'task-0', subject: 'walls', result: 'up' }, { id: 'task-1', subject: 'roof' }], runs: {} }
  expect(resultText(finished(peers))).toBe('--- task-0 walls ---\nup\n\n--- task-1 roof ---\n')
  // Nothing until it has finished, and nothing for a record that kept no result.
  expect(resultText({ status: 'running' })).toBeUndefined()
  expect(resultText({ status: 'failed', error: 'boom' })).toBeUndefined()
  expect(resultText(finished())).toBeUndefined()
})
