/**
 * The completion gate on board tasks (docs/05 B6b, exit criterion 4): a
 * gated peer-team's task completes only with passing evidence; work that
 * never passes is retried without the member leaving the pool, then a person
 * may accept it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SwarmBoard, foldBoard } from '../src/board'
import { SwarmJournal } from '../src/journal'
import { foldQuestions, recapJournal, type SwarmQuestionRequest } from '../src/run'
import { runBoardWorkers, runPeerTeam, type RunMember } from '../src/topologies'
import type { MemberRunResult, PeerTeamResult, PeerTeamSpec } from '../src/types'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-board-gate-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  return root
}

const gatedBoard = () => {
  const journal = SwarmJournal.open(join(mkdtempSync(join(tmpdir(), 'openswarm-board-gate-j-')), 'journal.jsonl'))
  return { journal, board: new SwarmBoard(journal, { gated: true }) }
}

const reply = (member: string, text: string): MemberRunResult => ({
  member,
  runId: 'r',
  text,
  output: [{ type: 'text', text }],
  stopReason: 'completed',
})

it('exit criterion 4: a member reporting done with a failing check is sent back, and every task closes on passing evidence', async () => {
  const root = gitRepo()
  const { journal, board } = gatedBoard()
  const check = 'test -f done.txt || (echo missing done.txt; false)'
  const prompts: string[] = []
  const run: RunMember = async (member, prompt) => {
    prompts.push(prompt)
    if (prompt === 'make done.txt') writeFileSync(join(root, 'wrong.txt'), 'x\n')
    else if (prompt.includes('## Continue')) writeFileSync(join(root, 'done.txt'), 'x\n')
    return reply(member.name, prompt === 'make done.txt' ? 'done, I think' : 'now done')
  }
  const result: PeerTeamResult = await runPeerTeam(
    {
      topology: 'peer-team',
      members: [{ name: 'm' }],
      // The first task's own check wins over the team's.
      tasks: [
        { subject: 'make done', prompt: 'make done.txt', checks: [check] },
        { subject: 'other', prompt: 'nothing to do' },
      ],
      gate: { checks: ['true'] },
    },
    run,
    board,
    undefined,
    undefined,
    { checks: ['true'], tree: () => ({ cwd: root }) },
  )

  // Sent back with the failing command and its output, then passed.
  expect(prompts[0]).toBe('make done.txt')
  expect(prompts[1]).toContain(check)
  expect(prompts[1]).toContain('missing done.txt')
  expect(result.tasks.map((t) => [t.subject, t.status, t.evidence?.kind, t.evidence?.passed, t.evidence?.round])).toEqual([
    ['make done', 'completed', 'commands', true, 2],
    ['other', 'completed', 'commands', true, 1],
  ])
  const snapshot = result.tasks[0]!.evidence!.snapshot!
  expect(execFileSync('git', ['show', `${snapshot}:done.txt`], { cwd: root }).toString()).toBe('x\n')

  // The journal: what the member was told each round, and no completion without passing evidence.
  expect(journal.events.filter((e) => e.type === 'swarm/gate').map((e) => e.data)).toEqual([
    { version: 1, taskId: 'task-0', member: 'm', round: 1, changed: true, kind: 'commands', passed: false, failedCommands: [check] },
    { version: 1, taskId: 'task-0', member: 'm', round: 2, changed: true, kind: 'commands', passed: true },
    { version: 1, taskId: 'task-1', member: 'm', round: 1, changed: false, kind: 'commands', passed: true },
  ])
  for (const event of journal.events.filter((e) => e.type === 'swarm/task')) {
    const { task } = event.data as { task: { status: string; evidence?: { passed: boolean } } }
    if (task.status === 'completed') expect(task.evidence?.passed).toBe(true)
  }
  expect(recapJournal(journal.events).map((line) => line.replace(/^#\d+ /, ''))).toEqual([
    'task-0 created: make done',
    'task-1 created: other',
    'task-0 claimed by m',
    `task-0 gate round 1 (m): checks not passed (failed: ${check})`,
    'task-0 gate round 2 (m): checks passed',
    'task-0 completed by m (commands, round 2): now done',
    'task-1 claimed by m',
    'task-1 gate round 1 (m): checks passed',
    'task-1 completed by m (commands, round 1): now done',
  ])
})

it('a gated board refuses to complete a task without passing evidence; an ungated one still completes without', async () => {
  const { board } = gatedBoard()
  const task = await board.create({ subject: 's', prompt: 'p' })
  const claimed = await board.claim(task.id, 'alice', task.revision)
  await expect(board.complete(task.id, 'alice', claimed.revision, 'trust me')).rejects.toMatchObject({ code: 'SWARM_TASK_UNVERIFIED' })
  await expect(
    board.complete(task.id, 'alice', claimed.revision, 'r', { kind: 'commands', passed: false, round: 1 }),
  ).rejects.toMatchObject({ code: 'SWARM_TASK_UNVERIFIED' })
  const evidence = { kind: 'commands', passed: true, round: 1, snapshot: 'abc' } as const
  expect(await board.complete(task.id, 'alice', claimed.revision, 'r', evidence)).toMatchObject({ status: 'completed', evidence })

  const journal = SwarmJournal.open(join(mkdtempSync(join(tmpdir(), 'openswarm-board-gate-j-')), 'journal.jsonl'))
  const ungated = new SwarmBoard(journal)
  const plain = await ungated.create({ subject: 's', prompt: 'p' })
  const done = await ungated.complete(plain.id, 'bob', (await ungated.claim(plain.id, 'bob', plain.revision)).revision, 'r')
  expect(done.status).toBe('completed')
  expect(done.evidence).toBeUndefined()
})

it('a task that never passes is retried with the member still in the pool, then abandoned by default', async () => {
  const root = gitRepo()
  const never = async (ask: (q: SwarmQuestionRequest) => Promise<string>) => {
    const { board } = gatedBoard()
    const task = await board.create({ subject: 'never', prompt: 'p', checks: ['false'] })
    const ran: string[] = []
    const outcome = await runBoardWorkers(
      [{ name: 'm1' }],
      board,
      new Set([task.id]),
      async (member) => {
        ran.push(member.name)
        writeFileSync(join(root, `attempt-${ran.length}.txt`), 'x\n')
        return reply(member.name, 'done')
      },
      undefined,
      2,
      ask,
      { rounds: 1, tree: () => ({ cwd: root }) },
    ).catch((error: Error) => error.message)
    return { outcome, ran, task: board.list()[0]! }
  }

  const asked: SwarmQuestionRequest[] = []
  const abandoned = await never(async (question) => (asked.push(question), question.default))
  // A lone member ran both attempts: work that failed its check is no casualty.
  expect(abandoned.ran).toEqual(['m1', 'm1'])
  expect(abandoned.outcome).toMatch(/abandoned 1 task\(s\) — task-0: not accepted after 1 gate round\(s\)/)
  expect(asked).toEqual([
    expect.objectContaining({ trigger: 'verifier-failure', kind: 'approval', options: ['abandon', 'accept'], default: 'abandon' }),
  ])
  expect(abandoned.task).toMatchObject({ status: 'pending' })
  expect(abandoned.task.evidence).toBeUndefined()

  // An 'accept' nobody is named for waives nothing (P8).
  const anonymous = await never(async () => 'accept')
  expect(anonymous.outcome).toMatch(/abandoned 1 task/)
})

it("answering 'accept' completes a task that never passed, with the answerer as human evidence", async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      members: [{ name: 'm' }],
      tasks: [{ subject: 'never', prompt: 'p' }],
      gate: { rounds: 1, checks: ['false'] },
      maxTaskAttempts: 1,
    },
    { parent: h.lead.agent, confidenceCwd: gitRepo(), questions: { timeoutMs: 60_000 } },
  )
  await vi.waitFor(() => expect(foldQuestions(run.journal.events).get('q-0')?.status).toBe('open'), { timeout: 10_000 })
  expect(foldQuestions(run.journal.events).get('q-0')).toMatchObject({
    trigger: 'verifier-failure',
    kind: 'approval',
    options: ['abandon', 'accept'],
    default: 'abandon',
  })
  run.answer('q-0', 'accept', 'owner')
  const result = await run.result

  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  expect(result.tasks[0]).toMatchObject({ status: 'completed', evidence: { kind: 'human', passed: true, by: 'owner' } })
  expect([...foldBoard(run.journal.events).values()][0]!.evidence).toEqual({ kind: 'human', passed: true, by: 'owner' })
  const recap = h.swarm.view(run.id).recap.map((line) => line.replace(/^#\d+ /, ''))
  expect(recap).toContain('task-0 gate round 1 (m): checks not passed (failed: false)')
  expect(recap).toContain('task-0 completed by m (human: owner): done')
})

it('review-mode gating without worktree execution fails before any task runs', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const spec: PeerTeamSpec = { topology: 'peer-team', members: [{ name: 'm' }], tasks: [{ subject: 'unchecked', prompt: 'p' }] }
  const reviewed = await h.swarm.start({ ...spec, gate: {} }, { parent: h.lead.agent })
  await expect(reviewed.result).rejects.toThrow(
    'gated task "unchecked" has no checks, so a reviewer would measure it, and the reviewer runs as a worktree member: run with worktree execution (RunTeamOptions.worktrees) or give every task checks',
  )
  expect(reviewed.board().list()).toEqual([])
  const off = await h.swarm.start({ ...spec, gate: { review: false } }, { parent: h.lead.agent })
  await expect(off.result).rejects.toThrow(`gated task "unchecked" has no checks and the team's gate has review off; give it checks`)
  expect(h.mock.requests).toHaveLength(0)
})

it('a gated messaging team is refused before any task runs, on any execution path', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const spec: PeerTeamSpec = {
    topology: 'peer-team',
    messaging: true,
    members: [{ name: 'm' }],
    tasks: [{ subject: 's', prompt: 'p', checks: ['true'] }],
    gate: {},
  }
  const refused = 'the completion gate (peer-team gate) does not cover messaging teams yet; drop gate or messaging'
  const inProcess = await h.swarm.start(spec, { parent: h.lead.agent })
  await expect(inProcess.result).rejects.toThrow(refused)
  const repo = gitRepo()
  const worktree = await h.swarm.start(spec, { parent: h.lead.agent, worktrees: { repoRoot: repo } })
  await expect(worktree.result).rejects.toThrow(refused)
  for (const run of [inProcess, worktree]) expect(run.board().list()).toEqual([])
  // Not even a member briefing went out.
  expect(h.mock.requests).toHaveLength(0)
})

it('a cancelled gated run starts no further gate round: no more checks run, no more member rounds', async () => {
  const root = gitRepo()
  const { board } = gatedBoard()
  const count = join(mkdtempSync(join(tmpdir(), 'openswarm-board-gate-count-')), 'checks')
  const seeded = new Set<string>()
  for (const subject of ['a', 'b', 'c']) seeded.add((await board.create({ subject, prompt: subject, checks: [`echo x >> ${count}`] })).id)
  const controller = new AbortController()
  const ran: string[] = []
  const outcome = await runBoardWorkers(
    [{ name: 'm1' }],
    board,
    seeded,
    async (member, claimed) => {
      ran.push(claimed.subject)
      // Cancelled mid-round, as a person cancelling the run would.
      controller.abort(new Error('run cancelled'))
      return reply(member.name, 'done')
    },
    undefined,
    undefined,
    undefined,
    { signal: controller.signal, tree: () => ({ cwd: root }) },
  ).catch((error: Error) => error.message)

  // The round the cancel cut short is not measured (its checks could close a
  // task the run was told to stop), and nothing after it starts.
  expect(ran).toEqual(['a'])
  expect(existsSync(count)).toBe(false)
  expect(outcome).toMatch(/abandoned 3 task\(s\)/)
  expect(Object.fromEntries(board.list().map((t) => [t.subject, t.status]))).toEqual({ a: 'pending', b: 'pending', c: 'pending' })
})
