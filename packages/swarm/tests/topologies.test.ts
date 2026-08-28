import { expect, it } from 'vitest'
import {
  parseNumberedPlan,
  runCascade,
  runCommittee,
  runCoordinator,
  runPipeline,
  type RunMember,
} from '../src/topologies'
import type { MemberRunResult, MemberSpec } from '../src/types'

/** Scripted member runner: replies per member name (FIFO), records prompts. */
function fakeRun(script: Record<string, string[]>) {
  const prompts: { member: string; prompt: string }[] = []
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]))
  const run: RunMember = async (member: MemberSpec, prompt: string): Promise<MemberRunResult> => {
    prompts.push({ member: member.name, prompt })
    const queue = queues.get(member.name)
    const text = queue?.shift()
    if (text === undefined) throw new Error(`no scripted reply left for "${member.name}"`)
    return {
      member: member.name,
      runId: `run-${prompts.length}`,
      text,
      output: [{ type: 'text', text }],
      stopReason: 'completed',
    }
  }
  return { run, prompts }
}

const m = (name: string): MemberSpec => ({ name })

it('committee collects all answers and feeds them to the judge', async () => {
  const { run, prompts } = fakeRun({
    a: ['answer-A'],
    b: ['answer-B'],
    judge: ['the synthesis'],
  })
  const result = await runCommittee(
    { topology: 'committee', members: [m('a'), m('b')], task: 'decide', judge: m('judge') },
    run,
  )
  expect(result.answers.map((a) => a.text)).toEqual(['answer-A', 'answer-B'])
  expect(result.synthesis?.text).toBe('the synthesis')
  const judgePrompt = prompts.find((p) => p.member === 'judge')!.prompt
  expect(judgePrompt).toContain('answer-A')
  expect(judgePrompt).toContain('answer-B')
})

it('committee without a judge returns answers only', async () => {
  const { run } = fakeRun({ a: ['x'], b: ['y'] })
  const result = await runCommittee(
    { topology: 'committee', members: [m('a'), m('b')], task: 't' },
    run,
  )
  expect(result.synthesis).toBeUndefined()
  expect(result.answers).toHaveLength(2)
})

it('pipeline threads each stage output into the next prompt', async () => {
  const { run, prompts } = fakeRun({ extract: ['the-facts'], write: ['the-draft'], polish: ['final'] })
  const result = await runPipeline(
    {
      topology: 'pipeline',
      stages: [
        { member: m('extract'), prompt: 'extract facts' },
        { member: m('write'), prompt: 'write draft' },
        { member: m('polish'), prompt: 'polish' },
      ],
    },
    run,
  )
  expect(result.final.text).toBe('final')
  expect(prompts[1]!.prompt).toContain('the-facts')
  expect(prompts[2]!.prompt).toContain('the-draft')
  expect(prompts[0]!.prompt).not.toContain('previous stage')
})

it('cascade escalates on gate rejection and threads feedback to the next tier', async () => {
  const { run, prompts } = fakeRun({
    cheap: ['cheap-attempt'],
    strong: ['strong-attempt'],
    gate: ['REVISE: too shallow', 'APPROVED'],
  })
  const result = await runCascade(
    { topology: 'cascade', tiers: [m('cheap'), m('strong')], task: 'solve it', gate: m('gate') },
    run,
  )
  expect(result.accepted).toBe(true)
  expect(result.tier).toBe(1)
  expect(result.final.text).toBe('strong-attempt')
  expect(result.attempts).toHaveLength(2)
  const strongPrompt = prompts.find((p) => p.member === 'strong')!.prompt
  expect(strongPrompt).toContain('REVISE: too shallow')
})

it('cascade without a gate accepts the first completed tier', async () => {
  const { run, prompts } = fakeRun({ cheap: ['done'], strong: [] })
  const result = await runCascade(
    { topology: 'cascade', tiers: [m('cheap'), m('strong')], task: 't' },
    run,
  )
  expect(result.accepted).toBe(true)
  expect(result.tier).toBe(0)
  expect(prompts).toHaveLength(1)
})

it('cascade exhausting every tier returns unaccepted with the last attempt', async () => {
  const { run } = fakeRun({
    cheap: ['a1'],
    strong: ['a2'],
    gate: ['REVISE: no', 'REVISE: still no'],
  })
  const result = await runCascade(
    { topology: 'cascade', tiers: [m('cheap'), m('strong')], task: 't', gate: m('gate') },
    run,
  )
  expect(result.accepted).toBe(false)
  expect(result.tier).toBe(1)
  expect(result.final.text).toBe('a2')
})

it('coordinator decomposes, round-robins workers, and synthesizes', async () => {
  const { run, prompts } = fakeRun({
    boss: ['1. first part\n2. second part\n3. third part', 'the synthesis'],
    w1: ['r-first', 'r-third'],
    w2: ['r-second'],
  })
  const result = await runCoordinator(
    { topology: 'coordinator', coordinator: m('boss'), workers: [m('w1'), m('w2')], task: 'big job' },
    run,
  )
  expect(result.subtasks.map((s) => s.worker)).toEqual(['w1', 'w2', 'w1'])
  expect(result.subtasks.map((s) => s.prompt)).toEqual(['first part', 'second part', 'third part'])
  expect(result.synthesis.text).toBe('the synthesis')
  const synthPrompt = prompts.at(-1)!.prompt
  expect(synthPrompt).toContain('r-first')
  expect(synthPrompt).toContain('r-second')
  expect(synthPrompt).toContain('r-third')
})

it('coordinator reports progress as the plan, each subtask, and the synthesis land', async () => {
  const { run } = fakeRun({
    boss: ['1. first part\n2. second part\n3. third part', 'the synthesis'],
    w1: ['r-first', 'r-third'],
    w2: ['r-second'],
  })
  const lines: string[] = []
  await runCoordinator(
    { topology: 'coordinator', coordinator: m('boss'), workers: [m('w1'), m('w2')], task: 'big job' },
    run,
    (line) => lines.push(line),
  )

  expect(lines[0]).toContain('planning with boss')
  expect(lines[1]).toBe('plan: 3 subtask(s) across 2 worker(s)')
  // One line per settled subtask, counted by completion order so the running
  // tally is monotonic even though subtasks settle out of order.
  expect(lines.slice(2, 5).map((l) => l.slice(0, 5))).toEqual(['[1/3]', '[2/3]', '[3/3]'])
  expect(lines.slice(2, 5).join('\n')).toContain('first part')
  expect(lines.at(-1)).toContain('synthesizing with boss')
})

it('coordinator without a progress callback still runs (the default is a no-op)', async () => {
  const { run } = fakeRun({ boss: ['1. only part', 'done'], w: ['r'] })
  const result = await runCoordinator(
    { topology: 'coordinator', coordinator: m('boss'), workers: [m('w')], task: 't' },
    run,
  )
  expect(result.synthesis.text).toBe('done')
})

it('coordinator fails loud on an unparseable plan', async () => {
  const { run } = fakeRun({ boss: ['no list here'], w: [] })
  await expect(
    runCoordinator(
      { topology: 'coordinator', coordinator: m('boss'), workers: [m('w')], task: 't' },
      run,
    ),
  ).rejects.toThrow('no parseable numbered subtasks')
})

it('parseNumberedPlan accepts 1. and 2) forms and ignores prose', () => {
  expect(parseNumberedPlan('intro\n1. alpha\n 2) beta \nnot a task\n10. gamma')).toEqual([
    'alpha',
    'beta',
    'gamma',
  ])
})
