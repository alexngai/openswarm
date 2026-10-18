/**
 * Landing through GitHub's merge queue (docs/05 D4, exit criterion 4),
 * keyless against a fake `gh`: each task branch is pushed, opened as a pull
 * request against the base with its landing evidence as the body, and queued
 * with `gh pr merge --auto`; merged is landed, closed is ejected, still open
 * past the wait is withheld; outcomes and evidence go to the run's train
 * journal, where `openswarm landings` reads them.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { SwarmJournal, validateForge } from '../src/index'
import { bootHarness, type TestHarness } from './boot'

const FAKE = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url))
let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
beforeAll(() => chmodSync(FAKE, 0o755))

async function run(states: Record<string, string>, extra: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-forge-'))
  const remote = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const repo = join(dir, 'repo')
  execFileSync('git', ['clone', '-q', remote, repo])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  git('add', '.')
  git('commit', '-qm', 'base')
  git('push', '-q', 'origin', 'HEAD:main')
  const ghDir = join(dir, 'gh')
  execFileSync('mkdir', ['-p', ghDir])
  writeFileSync(join(ghDir, 'state.json'), JSON.stringify(states))
  process.env['FAKE_GH_DIR'] = ghDir
  h = await bootHarness({
    sequence: Array.from({ length: 4 }, () => ['tool_call_success', 'success'] as const).flat(),
    repeatLast: true,
    successText: 'done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"' }),
  })
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  const handle = await h.swarm.start(
    { topology: 'peer-team', members: [{ name: 'm' }], tasks: [{ subject: 'first fix', prompt: 'do the first' }, { subject: 'second fix', prompt: 'do the second' }] },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } }, forge: { kind: 'github', command: FAKE, pollMs: 10, ...extra } },
    },
  )
  const result = await handle.result
  const log = existsSync(join(ghDir, 'log.jsonl')) ? readFileSync(join(ghDir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  return { result, log, remote, repo, git, journal: SwarmJournal.read(join(h.runsDir, handle.id, 'train.jsonl')), handle }
}

it('each task branch becomes a pull request queued to merge; merged lands, closed is ejected, and the evidence is the body and the journal', async () => {
  const { result, log, git, journal, handle } = await run({ '1': 'MERGED', '2': 'CLOSED' })
  expect(result.git!.landed!.map((l) => l.taskKey)).toEqual(['task-0'])
  expect(result.git!.ejected).toEqual([expect.objectContaining({ taskKey: 'task-1', reason: 'pull request #2 was closed without merging' })])
  const creates = log.filter((c) => c.argv[1] === 'create')
  expect(creates.map((c) => c.argv.slice(2, 8))).toEqual([
    ['--base', 'main', '--head', expect.stringMatching(/^swarm\/\w+\/task-0$/), '--title', 'first fix'],
    ['--base', 'main', '--head', expect.stringMatching(/^swarm\/\w+\/task-1$/), '--title', 'second fix'],
  ])
  expect(creates[0].body).toContain('task-0')
  expect(creates[0].body).toMatch(/diff on \w+: 1 file\(s\)/)
  expect(log.filter((c) => c.argv[1] === 'merge').map((c) => c.argv.slice(2))).toEqual([
    ['1', '--auto', '--merge'],
    ['2', '--auto', '--merge'],
  ])
  // The branches were pushed for the pull requests.
  git('fetch', '-q', 'origin')
  expect(git('branch', '-r')).toMatch(/origin\/swarm\/\w+\/task-0/)
  const bundles = journal.filter((e) => e.type === 'train/evidence').map((e) => e.data as any)
  expect(bundles.map((b) => [b.key, b.outcome, b.via])).toEqual([
    ['task-0', 'landed', 'forge'],
    ['task-1', 'ejected', 'forge'],
  ])
  expect(h!.swarm.landings(handle.id).map((l) => l.key).sort()).toEqual(['task-0', 'task-1'])
}, 120_000)

it('a pull request still in the queue when the wait ends is withheld, left to the queue', async () => {
  const { result } = await run({ '1': 'MERGED' }, { waitMs: 0, method: 'squash' })
  expect(result.git!.landed!.map((l) => l.taskKey)).toEqual(['task-0'])
  expect(result.git!.withheld.map((w) => w.taskKey)).toEqual(['task-1'])
}, 120_000)

it('the forge config is checked before any spend', () => {
  expect(() => validateForge({ kind: 'gitlab' as any })).toThrow('kind must be github')
  expect(() => validateForge({ kind: 'github', method: 'fast-forward' as any })).toThrow('merge, squash or rebase')
  expect(() => validateForge({ kind: 'github', waitMs: -1 })).toThrow('non-negative')
})
