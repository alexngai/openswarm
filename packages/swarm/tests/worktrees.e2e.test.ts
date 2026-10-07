/**
 * Phase-2 end-to-end: member runs execute as real subprocess harnesses
 * (dsh-jsonrpc-agent over stdio JSON-RPC) in per-task git worktrees; task
 * branches merge into the integration branch. One member works board tasks
 * sequentially so the shared mock LLM's FIFO script stays deterministic;
 * the scripted bash command derives its output from the current branch, so
 * each worktree produces distinct content.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import { afterEach, expect, it } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-wt-e2e-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

const show = (root: string, ref: string, file: string) =>
  execFileSync('git', ['show', `${ref}:${file}`], { cwd: root }).toString()

function memberEnv(h: TestHarness): Record<string, string> {
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  return {
    OPENSWARM_LLM_BASE_URL: base,
    OPENSWARM_LLM_API_KEY: 'mock-key',
    DSH_MODEL: 'mock-model',
  }
}

/** Member harness subprocesses still parented to this test worker. */
function harnessChildren(): string[] {
  let pids: string[]
  try {
    pids = execFileSync('bash', ['-c', `pgrep -P ${process.pid} 2>/dev/null || true`])
      .toString()
      .trim()
      .split('\n')
      .filter((p) => p !== '')
  } catch {
    return []
  }
  return pids.filter((pid) => {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', pid]).toString().includes('dsh-sdk-jsonrpc')
    } catch {
      return false
    }
  })
}

/**
 * Disposing the provider plugin does NOT reap the run — `SubagentRun.dispose()`
 * does. Awaiting `result` without it orphaned one harness subprocess per member,
 * surviving past the provider's SIGTERM/SIGKILL grace, so a long-lived server or
 * a multi-cell eval accumulated them until the host ran out.
 *
 * The suite could not have caught this before: vitest force-exits its workers, so
 * the orphans died with the runner and the leak was invisible. This asserts on
 * the process table directly for that reason.
 */
it('a worktree member run leaves no orphaned harness process', async () => {
  const repo = scratchRepo()
  const before = harnessChildren().length
  h = await bootHarness({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'echo done > out.txt' }),
  })

  await h.swarm.runTeam(
    {
      topology: 'fanout',
      members: [{ name: 'solo' }],
      tasks: [{ member: 'solo', prompt: 'do it' }],
    },
    { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { env: memberEnv(h) } } },
  )

  await new Promise((resolve) => setTimeout(resolve, 1_000))
  expect(harnessChildren().length, 'member harness subprocess was not reaped').toBe(before)
}, 120_000)

it('worktree members edit isolated checkouts and merge into the integration branch', async () => {
  const repo = scratchRepo()
  h = await bootHarness({
    // Per task turn: one bash call, then a closing message. One member works
    // the two board tasks sequentially, so FIFO order is task0(bash, done),
    // task1(bash, done). The scripted command writes a file named and filled
    // by the current branch — distinct per worktree.
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({
      command: 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"',
    }),
  })

  const result = await h.swarm.runTeam(
    {
      topology: 'peer-team',
      members: [{ name: 'solo' }],
      tasks: [
        { subject: 'first', prompt: 'do the first task' },
        { subject: 'second', prompt: 'do the second task' },
      ],
    },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
    },
  )

  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  expect(result.git).toBeDefined()
  const git = result.git!
  expect(git.conflicts).toEqual([])
  expect(git.merged).toHaveLength(2)
  // Each merged branch carried its own branch-named file into the target.
  for (const merged of git.merged) {
    const flat = merged.branch.replace(/\//g, '-')
    expect(show(repo, git.targetBranch, `out-${flat}.txt`).trim()).toBe(flat)
  }
  // The user's checkout was never touched.
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('')
  expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).toString().trim()).toBe(
    'main',
  )
}, 120_000)

it('overlapping edits: one branch merges, the other is retained as a conflict', async () => {
  const repo = scratchRepo()
  h = await bootHarness({
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    // Same file, branch-dependent content: guaranteed conflict at merge time.
    toolArguments: JSON.stringify({
      command: 'git rev-parse --abbrev-ref HEAD > shared.txt',
    }),
  })

  const result = await h.swarm.runTeam(
    {
      topology: 'peer-team',
      members: [{ name: 'solo' }],
      tasks: [
        { subject: 'one', prompt: 'write one' },
        { subject: 'two', prompt: 'write two' },
      ],
    },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
    },
  )

  const git = result.git!
  expect(git.merged).toHaveLength(1)
  expect(git.conflicts).toHaveLength(1)
  // The conflicted branch survives with its version intact.
  const kept = git.conflicts[0]!
  expect(show(repo, kept.branch, 'shared.txt')).toContain(kept.branch.split('/').pop()!)
}, 120_000)

it('a gated task: a round that breaks a passing check is rolled back in its worktree, the checkout untouched (docs/05 B6b)', async () => {
  const repo = scratchRepo()
  // The round counter lives in the task's worktree, ignored, so no snapshot
  // or rollback touches it and the member sandbox allows the write.
  writeFileSync(join(repo, '.gitignore'), '.round\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore'], { cwd: repo })
  h = await bootHarness({
    // One subprocess member per gate round: a bash call, then a closing message.
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'round done',
    toolName: 'bash',
    // Round 1 makes one.txt; round 2 deletes it (breaking a passing check) and strays; round 3 makes two.txt.
    toolArguments: JSON.stringify({
      command: 'n=$(( $(cat .round 2>/dev/null || echo 0) + 1 )); echo $n > .round; case $n in 1) touch one.txt;; 2) rm one.txt; touch stray.txt;; 3) touch two.txt;; esac',
    }),
  })

  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      members: [{ name: 'solo' }],
      tasks: [{ subject: 'one and two', prompt: 'make one.txt and two.txt' }],
      gate: { checks: ['test -f one.txt', 'test -f two.txt'] },
    },
    { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { env: memberEnv(h) } } },
  )
  const result = await run.result

  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  const rounds = run.journal.events
    .filter((e) => e.type === 'swarm/gate')
    .map((e: any) => [e.data.round, e.data.passed, e.data.rolledBack ?? false])
  expect(rounds).toEqual([
    [1, false, false],
    [2, false, true],
    [3, true, false],
  ])
  expect(result.tasks[0]!.evidence).toMatchObject({ kind: 'commands', passed: true, round: 3 })
  // Round 3 started from round 1's tree: one.txt back, the stray gone.
  const git = result.git!
  expect(git.merged).toHaveLength(1)
  expect(show(repo, git.targetBranch, 'one.txt')).toBe('')
  expect(show(repo, git.targetBranch, 'two.txt')).toBe('')
  expect(() => execFileSync('git', ['cat-file', '-e', `${git.targetBranch}:stray.txt`], { cwd: repo, stdio: 'ignore' })).toThrow()
  // The user's checkout was never touched.
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('')
  for (const file of ['one.txt', 'two.txt', 'stray.txt', '.round']) expect(existsSync(join(repo, file))).toBe(false)
}, 120_000)

/** Commit `files` on top of a scratch repo's main. */
function commitFiles(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'setup'], { cwd: repo })
}

it('a gated task cannot pass by editing a pinned check: the pinned paths are restored after every round (docs/05 B6b)', async () => {
  const repo = scratchRepo()
  commitFiles(repo, { '.gitignore': '.round\n', 'tests/check.sh': 'test -f impl.txt\n' })
  h = await bootHarness({
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'round done',
    toolName: 'bash',
    // Round 1 neuters the check; round 2 does the work.
    toolArguments: JSON.stringify({
      command: "n=$(( $(cat .round 2>/dev/null || echo 0) + 1 )); echo $n > .round; case $n in 1) echo 'exit 0' > tests/check.sh;; 2) touch impl.txt;; esac",
    }),
  })
  const progress: string[] = []
  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      members: [{ name: 'solo' }],
      tasks: [{ subject: 'impl', prompt: 'make impl.txt' }],
      gate: { checks: ['bash tests/check.sh'] },
    },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
      confidencePinPaths: ['tests'],
      onProgress: (line) => progress.push(line),
    },
  )
  const result = await run.result

  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  expect(run.journal.events.filter((e) => e.type === 'swarm/gate').map((e: any) => [e.data.round, e.data.passed])).toEqual([
    [1, false],
    [2, true],
  ])
  expect(progress).toContain('gate: discarded member edits to 1 pinned path(s): tests/check.sh')
  const git = result.git!
  expect(show(repo, git.targetBranch, 'tests/check.sh')).toBe('test -f impl.txt\n')
  expect(show(repo, git.targetBranch, 'impl.txt')).toBe('')
}, 120_000)

/** Whether this host can confine under workspace-write (no Seatbelt, bwrap or Landlock → not). */
async function canSandbox(): Promise<boolean> {
  const ctx = new Context()
  ctx.plugin((SandboxLocal as any).default ?? SandboxLocal)
  try {
    await new Promise<void>((resolve) => ctx.inject(['sandbox'], () => resolve()))
    const { argv } = (ctx as any).sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: tmpdir() })
    return spawnSync(argv[0], argv.slice(1)).status === 0
  } catch {
    return false
  } finally {
    await (ctx as any).fiber?.dispose?.()
  }
}

it('a gated task without checks is reviewed by a subprocess reviewer in a clone of its worktree (docs/05 B6b)', async () => {
  // Where the host cannot sandbox, the reviewer runs unsandboxed, as an operator would set it.
  const unsandboxed = !(await canSandbox())
  if (unsandboxed) process.env['OPENSWARM_GATE_REVIEWER_SANDBOX'] = 'danger-full-access'
  try {
    const repo = scratchRepo()
    const verdict = `all done\n${JSON.stringify({ targets: [{ target: 1, status: 'done', notes: 'works' }], regressions: 'none', score: 100 })}`
    h = await bootHarness({
      // The member answers at once; the reviewer writes a file in its tree, then gives its verdict.
      sequence: ['success', 'tool_call_success', 'success'],
      repeatLast: true,
      successText: verdict,
      toolName: 'bash',
      toolArguments: JSON.stringify({ command: 'echo "sandbox=$OPENSWARM_MEMBER_SANDBOX" > reviewer-was-here.txt; cat reviewer-was-here.txt' }),
    })
    const run = await h.swarm.start(
      { topology: 'peer-team', members: [{ name: 'solo' }], tasks: [{ subject: 'ship', prompt: 'ship it' }], gate: {} },
      { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { env: memberEnv(h) } } },
    )
    const result = await run.result

    if (result.topology !== 'peer-team') throw new Error('wrong topology')
    expect(result.tasks[0]!.evidence).toMatchObject({
      kind: 'review',
      passed: true,
      round: 1,
      score: 100,
      targets: [{ target: 1, status: 'done' }],
    })
    // One member turn, then the reviewer's two, as review.cordis.yml composes it, under its sandbox.
    expect(h.mock.requests).toHaveLength(3)
    const reviewer = JSON.stringify(h.mock.requests.slice(1))
    expect(reviewer).toContain('You are a coding agent working in the current directory')
    expect(reviewer).not.toContain('Complete your task by editing files')
    expect(reviewer).toContain(`sandbox=${unsandboxed ? 'danger-full-access' : 'workspace-write'}`)
    // The reviewer's edit went away with its clone: not in the task's branch, nor the checkout.
    const target = result.git!.targetBranch
    expect(() => execFileSync('git', ['cat-file', '-e', `${target}:reviewer-was-here.txt`], { cwd: repo, stdio: 'ignore' })).toThrow()
    expect(existsSync(join(repo, 'reviewer-was-here.txt'))).toBe(false)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('')
  } finally {
    if (unsandboxed) delete process.env['OPENSWARM_GATE_REVIEWER_SANDBOX']
  }
}, 120_000)
