/**
 * A gated peer-team's journals as a train landing leaves them (docs/05 B4,
 * B5), for the landing-evidence, metrics, protocol and CLI tests. The run's
 * journal is written as the run would write it: six board tasks closed on
 * their gate's evidence (L2 checks, a human waiver, a full L3 suite, an L1
 * review with a tamper advisory), their gate rounds, the waiver's question and
 * each member run's usage. Then the train lands their branches on a real repo
 * with scripted members: task-1's planted file is bisected out and its one
 * repair does not fix it, so it is ejected; task-3 conflicts with task-2 and
 * its resolver merges them. The scripted members journal their usage as a
 * worktree member's would, under the role the train gives them.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmGit, type MergeOutcome } from 'openswarm-git'
import {
  SwarmBoard,
  SwarmJournal,
  landTrain,
  trainVerify,
  type AskQuestion,
  type MemberSpec,
  type PeerTeamSpec,
  type RunMember,
  type SwarmQuestion,
  type SwarmRunRecord,
  type SwarmUsageEvent,
  type TaskEvidence,
  type Usage,
} from '../../src/index'

/** The train's check: a planted bad.txt fails it, printing its content (which no bundle may carry). */
export const BAD = 'test ! -f bad.txt || (cat bad.txt; false)'
export const PLANTED = 'PLANTED-CHECK-OUTPUT'

export const STARTED = 1_790_000_000_000
/** The run's wall clock, start to end. */
export const WALL_MS = 120_000
/** Task work per task, a review of task-5, and each train step, in tokens. */
export const TASK = { inputTokens: 700, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0, calls: 2 } satisfies Usage
export const REVIEW = { inputTokens: 250, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } satisfies Usage
export const STEP = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } satisfies Usage

const L2: TaskEvidence = { kind: 'commands', level: 2, passed: true, round: 1 }

/** Per task: subject, owner, branch files, gate rounds before it passed, and what it closed on. */
const TASKS: { subject: string; owner: string; files: Record<string, string>; failedRounds: number; evidence: TaskEvidence }[] = [
  { subject: 'core', owner: 'alice', files: { 'a.txt': 'a\n' }, failedRounds: 0, evidence: L2 },
  { subject: 'parser', owner: 'bob', files: { 'bad.txt': `${PLANTED}\n`, 'b.txt': 'b\n' }, failedRounds: 0, evidence: L2 },
  { subject: 'docs', owner: 'alice', files: { 'shared.txt': 'from docs\n' }, failedRounds: 2, evidence: { kind: 'human', passed: true, by: 'owner' } },
  { subject: 'config', owner: 'bob', files: { 'shared.txt': 'from config\n' }, failedRounds: 0, evidence: L2 },
  {
    subject: 'hidden',
    owner: 'alice',
    files: { 'd.txt': 'd\n' },
    failedRounds: 0,
    evidence: { kind: 'hidden', level: 3, passed: true, round: 1, suite: 'acceptance', total: 4, failed: 0, enforcement: 'full' },
  },
  { subject: 'review', owner: 'bob', files: { 'e.txt': 'e\n' }, failedRounds: 1, evidence: { kind: 'review', level: 1, passed: true, round: 2, score: 90 } },
]

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-landing-repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  return root
}

export interface LandingScenario {
  runId: string
  runDir: string
  root: string
  outcome: MergeOutcome
  /** Train steps the scripted members ran, with the role the train gave each. */
  steps: { member: string; key: string; role: string | undefined }[]
}

/** Write the scenario's run under `runsDir`, the train landing it for real; returns once the run is recorded finished. */
export async function landingScenario(runsDir: string, runId = 'run-1a2d1a2d'): Promise<LandingScenario> {
  const runDir = join(runsDir, runId)
  const journal = SwarmJournal.open(join(runDir, 'journal.jsonl'))
  const spec: PeerTeamSpec = {
    topology: 'peer-team',
    intent: { purpose: 'ship the parser', endState: 'every check passes' },
    members: [{ name: 'alice' }, { name: 'bob' }],
    tasks: TASKS.map((t, i) => ({
      subject: t.subject,
      prompt: `do ${t.subject}`,
      ...(i === 3 ? { intent: { purpose: 'load the config', endState: 'config loads' } } : {}),
    })),
    gate: { checks: ['true'] },
  }
  const running: SwarmRunRecord = {
    id: runId,
    status: 'running',
    topology: 'peer-team',
    parentSessionId: 'lead',
    writer: { pid: process.pid, host: hostname(), incarnation: journal.incarnation },
    startedAt: STARTED,
    landing: 'train',
    usageJournaled: true,
    spec,
  }
  await journal.append('swarm/run', { version: 1, run: running })

  const usage = (member: string, taskKey: string, role: SwarmUsageEvent['role'], u: Usage, model = 'model-a') =>
    journal.append('swarm/usage', { version: 1, member, role, taskKey, runtime: 'dsh:sdk', provider: 'openai', model, runId: `r-${taskKey}-${role}`, usage: u, startedAt: STARTED } satisfies SwarmUsageEvent)
  let asked = 0
  /** A question as the run journals it: raised, then closed. */
  const question = async (raised: Pick<SwarmQuestion, 'trigger' | 'prompt' | 'options' | 'default'> & Partial<SwarmQuestion>, closed: Partial<SwarmQuestion>) => {
    const open = { id: `q-${asked++}`, kind: 'escalation', tier: 'low', status: 'open', raisedAt: Date.now(), ...raised } as SwarmQuestion
    await journal.append('swarm/question', { version: 1, question: open })
    await journal.append('swarm/question', { version: 1, question: { ...open, ...closed } })
  }

  // The gated board, each task closed on its gate's evidence as runBoardWorkers closes it.
  const board = new SwarmBoard(journal, { gated: true })
  for (const [i, t] of TASKS.entries()) await board.create({ subject: t.subject, prompt: `do ${t.subject}`, ...(spec.tasks[i]!.intent === undefined ? {} : { intent: spec.tasks[i]!.intent }) })
  for (const [i, t] of TASKS.entries()) {
    const id = `task-${i}`
    const claimed = await board.claim(id, t.owner, 0)
    await usage(t.owner, id, 'task', TASK)
    for (let round = 1; round <= t.failedRounds; round++) {
      await board.recordGate({ taskId: id, member: t.owner, round, changed: true, kind: 'commands', level: 2, passed: false, failedCommands: ['npm test'] })
    }
    if (t.evidence.kind === 'human') {
      // Out of attempts: a person accepts it without passing evidence.
      const raisedAt = STARTED + 10_000
      await question(
        { taskId: id, trigger: 'verifier-failure', kind: 'approval', prompt: `task ${id} "docs" did not pass its gate`, options: ['abandon', 'accept'], default: 'abandon', raisedAt },
        { status: 'answered', answer: 'accept', by: 'owner', closedAt: raisedAt + 30_000 },
      )
    } else {
      await board.recordGate({ taskId: id, member: t.owner, round: t.failedRounds + 1, changed: true, kind: t.evidence.kind as 'commands', level: t.evidence.level as 2, passed: true })
    }
    if (t.subject === 'review') {
      await usage('reviewer', id, 'review', REVIEW, 'model-b')
      await journal.append('swarm/tamper', {
        version: 1,
        taskId: id,
        member: t.owner,
        round: 2,
        suite: '',
        severity: 'advisory',
        signals: [{ signal: 'verifier-user', severity: 'advisory', where: 'transcript', match: '_openswarmverifier' }],
      })
    }
    await board.complete(id, t.owner, claimed.revision, `${t.subject} done`, t.evidence)
  }

  // The train, landing the six branches on a real repo.
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'scn' })
  for (const [i, t] of TASKS.entries()) {
    const worktree = await git.worktree(`task-${i}`)
    for (const [path, text] of Object.entries(t.files)) writeFileSync(join(worktree.path, path), text)
    await git.autoCommit(worktree, `work task-${i}`)
  }
  const steps: LandingScenario['steps'] = []
  const run: RunMember = async (member, prompt, key, role) => {
    steps.push({ member: member.name, key: key!, role })
    const cwd = (await git.worktree(key!)).path
    // The resolver merges both sides; the repair leaves the planted file in place.
    if (prompt.includes('## Integrate')) writeFileSync(join(cwd, 'shared.txt'), 'from docs\nfrom config\n')
    else writeFileSync(join(cwd, 'notes.txt'), 'tried\n')
    await usage(member.name, key!, role!, STEP)
    return { member: member.name, runId: 'r', text: 'done', output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }
  }
  // Unattended: every question the train raises takes its default.
  const ask: AskQuestion = async (request) => {
    await question(request, { status: 'defaulted', answer: request.default, closedAt: Date.now() })
    return request.default
  }
  const config = { checks: [BAD], maxRepairs: 1 }
  const outcome = await landTrain(git, config, {
    journal: SwarmJournal.open(join(runDir, 'train.jsonl')),
    runEvents: () => journal.events,
    tasks: board.list(),
    owners: new Map(TASKS.map((t, i) => [`task-${i}`, { member: { name: t.owner } as MemberSpec, prompt: `do ${t.subject}` }])),
    members: spec.members,
    run,
    ask,
    verify: trainVerify(config),
  })
  await git.dispose()
  await journal.append('swarm/run', {
    version: 1,
    run: { ...running, status: 'finished', endedAt: STARTED + WALL_MS, result: { topology: 'peer-team', tasks: board.list(), runs: {}, git: outcome } },
  })
  return { runId, runDir, root, outcome, steps }
}
