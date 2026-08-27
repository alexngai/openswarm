/**
 * Phase-2 end-to-end: member runs execute as real subprocess harnesses
 * (dsh-jsonrpc-agent over stdio JSON-RPC) in per-task git worktrees; task
 * branches merge into the integration branch. One member works board tasks
 * sequentially so the shared mock LLM's FIFO script stays deterministic;
 * the scripted bash command derives its output from the current branch, so
 * each worktree produces distinct content.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
