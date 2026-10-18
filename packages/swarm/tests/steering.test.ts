/**
 * Steering a one-shot team (docs/05 §6.1, R2): every member of a team that is
 * not a messaging peer-team is addressable from the start. A steer to a
 * member whose run takes no message mid-turn waits as quiet mail and rides in
 * front of its next run's prompt (`enqueue`); one to a claude-code member
 * with a turn open is written into that turn (`immediate`).
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { SwarmJournal } from '../src/index'
import { bootHarness, type TestHarness } from './boot'

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url))
let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
  delete process.env['FAKE_CLAUDE_LOG']
})
beforeAll(() => chmodSync(FAKE, 0o755))

async function until(test: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !test(); ) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

it('a one-shot member is steerable from the start: the message waits as quiet mail and rides in front of its next run, delivered once', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const run = await h.swarm.start(
    { topology: 'peer-team', members: [{ name: 'a' }], tasks: [{ subject: 'first', prompt: 'do the first' }, { subject: 'second', prompt: 'do the second', blockedBy: [0] }] },
    { parent: h.lead.agent },
  )
  expect(await run.steer('a', 'STEER: prefer the small fix')).toBe('enqueue')
  await expect(run.steer('nobody', 'x')).rejects.toThrow(`run ${run.id} has no member "nobody"`)
  await run.result
  // Exactly one of its runs carried it, framed as a swarm message from the owner.
  const carrying = h.mock.requests.filter((r) => JSON.stringify(r.body).includes('STEER: prefer the small fix'))
  expect(carrying).toHaveLength(1)
  expect(JSON.stringify(carrying[0]!.body)).toMatch(/Swarm message msg-[\w-]+ from owner/)
  const events = SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl'))
  const queued = events.filter((e) => e.type === 'swarm/message/queued').map((e) => (e.data as any).message)
  expect(queued).toEqual([expect.objectContaining({ from: 'owner', to: 'a', delivery: 'quiet', text: 'STEER: prefer the small fix' })])
  expect(events.filter((e) => e.type === 'swarm/message/delivered').map((e) => (e.data as any).messageId)).toEqual([queued[0].id])
  expect(events.find((e) => e.type === 'swarm/steer')?.data).toMatchObject({ to: 'a', delivery: 'enqueue', by: 'owner' })
}, 60_000)

it("a claude-code member's open turn takes a steer at once, as a user message in its session; after the turn, steering waits for the next run", async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'openswarm-steer-claude-')), 'log.jsonl')
  process.env['FAKE_CLAUDE_LOG'] = file
  const log = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const root = mkdtempSync(join(tmpdir(), 'openswarm-steer-repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })
  const run = await h.swarm.start(
    { topology: 'peer-team', members: [{ name: 'cc', runtime: 'claude-code' }], tasks: [{ subject: 'steer me', prompt: 'FAKE_STEER' }] },
    { parent: h.lead.agent, worktrees: { repoRoot: root, member: { claudeCommand: FAKE } } },
  )
  // The fake has its prompt and is waiting for a second user message.
  await until(() => log().some((e) => e.event === 'start'))
  expect(await run.steer('cc', 'turn left')).toBe('immediate')
  const result = await run.result
  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  expect(result.tasks[0]!.result).toBe('heard: turn left')
  expect(log().find((e) => e.event === 'steer')).toEqual({ event: 'steer', text: 'turn left' })
  expect(log().find((e) => e.event === 'start').argv).toContain('--input-format')
}, 60_000)
