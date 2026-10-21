/**
 * Durable runs' primitives (docs/05 D1), keyless over a real bare remote: a
 * leased push of the run's ref; a stale lease fenced, a transport error not;
 * concurrent compare-and-set pushes with one winner per round (exit
 * criterion 2's contention test, on a local bare remote, whose ref lock makes
 * one winner; what it tests is our handling of the refusals); a takeover
 * that waits out a live writer unless it steals, beats a second taker, and
 * fences the old writer at its next push.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { JournalMirror, pushLeased, remoteRunOid, takeOver, validateDurable } from '../src/durable'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

function world(hosts: number) {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-durable-'))
  const remote = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const seed = join(dir, 'seed')
  execFileSync('git', ['clone', '-q', remote, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-qm', 'base')
  sh(seed, 'push', '-q', 'origin', 'HEAD:main')
  const clones = Array.from({ length: hosts }, (_, i) => {
    const path = join(dir, `host${i}`)
    execFileSync('git', ['clone', '-q', remote, path])
    const runDir = join(dir, `runs${i}`, 'run-x')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'journal.jsonl'), `{"seq":0,"host":${i}}\n`)
    return { path, runDir }
  })
  return { dir, remote, clones }
}

/** A commit of `runDir`'s journal in `repo`, as the mirror makes one. */
const commitOf = (repo: string, runDir: string) => {
  const blob = sh(repo, 'hash-object', '-w', join(runDir, 'journal.jsonl'))
  const tree = execFileSync('git', ['mktree'], { cwd: repo, input: `100644 blob ${blob}\tjournal.jsonl\n`, encoding: 'utf8' }).trim()
  return sh(repo, 'commit-tree', tree, '-m', 'x')
}

it('a leased push lands the ref; a stale lease is fenced; a transport error is not a fence', async () => {
  const { clones } = world(1)
  const [a] = clones
  const first = await pushLeased(a!.path, 'origin', 'run-x', commitOf(a!.path, a!.runDir), undefined)
  expect(first.ok).toBe(true)
  // Expecting the ref absent again, with a new journal: refused for its lease.
  writeFileSync(join(a!.runDir, 'journal.jsonl'), '{"seq":0}\n{"seq":1}\n')
  const stale = await pushLeased(a!.path, 'origin', 'run-x', commitOf(a!.path, a!.runDir), undefined)
  expect(stale).toMatchObject({ ok: false, fenced: true })
  const gone = await pushLeased(a!.path, 'no-such-remote', 'run-x', commitOf(a!.path, a!.runDir), undefined)
  expect(gone).toMatchObject({ ok: false, fenced: false })
})

it('concurrent compare-and-set pushes to one ref: one winner per round', async () => {
  const { clones, remote } = world(6)
  let expected: string | undefined
  for (let round = 0; round < 3; round++) {
    // Every host's journal differs, each round: no two pushes are the same commit.
    for (const [i, c] of clones.entries()) writeFileSync(join(c.runDir, 'journal.jsonl'), `{"host":${i},"round":${round}}\n`)
    const results = await Promise.all(clones.map((c) => pushLeased(c.path, 'origin', 'run-x', commitOf(c.path, c.runDir), expected)))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.fenced)).toBe(true)
    expected = (results.find((r) => r.ok) as { oid: string }).oid
    expect(await remoteRunOid(clones[0]!.path, 'origin', 'run-x')).toBe(expected)
  }
  expect(remote).toBeTruthy()
})

it('a takeover waits out a live writer unless it steals, beats a second taker, and fences the old writer at its next push', async () => {
  const { clones } = world(3)
  const [writer, taker, late] = clones
  const fenced: string[] = []
  const mirror = new JournalMirror(writer!.path, { remote: 'origin' }, 'run-x', writer!.runDir, async () => [], (why) => fenced.push(why))
  expect(await mirror.checkpoint('start')).toBe('pushed')
  // The writer heartbeats while a polite taker waits its lease out.
  const beat = setInterval(() => void mirror.checkpoint('heartbeat'), 50)
  await expect(takeOver(taker!.path, 'origin', 'run-x', taker!.runDir, async () => {}, { ttlMs: 300 })).rejects.toThrow(/writer is alive/)
  clearInterval(beat)
  await mirror.checkpoint('settled')
  // Stealing: the journal comes across, the takeover is recorded and pushed.
  const recorded: string[] = []
  const lease = await takeOver(
    taker!.path,
    'origin',
    'run-x',
    taker!.runDir,
    async () => void (writeFileSync(join(taker!.runDir, 'journal.jsonl'), `${readFileSync(join(taker!.runDir, 'journal.jsonl'), 'utf8')}{"seq":1,"took":true}\n`), recorded.push('took')),
    { steal: true },
  )
  expect(recorded).toEqual(['took'])
  expect(readFileSync(join(taker!.runDir, 'journal.jsonl'), 'utf8')).toBe('{"seq":0,"host":0}\n{"seq":1,"took":true}\n')
  expect(await remoteRunOid(taker!.path, 'origin', 'run-x')).toBe(lease)
  // The old writer's next push is refused: fenced, it stops.
  expect(await mirror.checkpoint('after takeover')).toBe('fenced')
  expect(mirror.isFenced).toBe(true)
  expect(fenced[0]).toMatch(/another host took run run-x over/)
  expect(await mirror.checkpoint('again')).toBe('fenced')
  expect(await mirror.confirm('landing')).toBe(false)
  // Two takers that observed the same object, both stealing: one wins, the other is refused.
  let arrived = 0
  let both!: () => void
  const met = new Promise<void>((resolve) => (both = resolve))
  const barrier = async () => {
    if (++arrived === 2) both()
    await met
  }
  const results = await Promise.allSettled([taker, late].map((c) => takeOver(c!.path, 'origin', 'run-x', c!.runDir, barrier, { steal: true })))
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { message: expect.stringMatching(/took run run-x over first/) } })
})

it('an unreachable remote is not a fence, but confirms nothing; a stopped mirror pushes nothing; a long heartbeat is refused', async () => {
  const { clones } = world(1)
  const [a] = clones
  const fenced: string[] = []
  const lost = new JournalMirror(a!.path, { remote: 'no-such-remote' }, 'run-x', a!.runDir, async () => [], (why) => fenced.push(why))
  expect(await lost.checkpoint('heartbeat')).toBe('unreachable')
  expect(await lost.confirm('landing', 1)).toBe(false)
  expect(lost.isFenced).toBe(false)
  expect(fenced).toEqual([])
  const mirror = new JournalMirror(a!.path, { remote: 'origin' }, 'run-x', a!.runDir, async () => [], () => {})
  expect(await mirror.confirm('started')).toBe(true)
  mirror.stop()
  expect(await mirror.checkpoint('after stop')).toBe('fenced')
  expect(() => validateDurable({ remote: 'origin', heartbeatMs: 60_000 })).toThrow(/at most 30000/)
  expect(() => validateDurable({ remote: '' })).toThrow(/remote/)
})

it('a hook declining the push refuses the run ref too, but is no fence', async () => {
  const { clones, remote } = world(1)
  const [a] = clones
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho declined >&2\nexit 1\n', { mode: 0o755 })
  const declined = await pushLeased(a!.path, 'origin', 'run-x', commitOf(a!.path, a!.runDir), undefined, ['main'])
  expect(declined).toMatchObject({ ok: false, fenced: false })
})

it('a lock on a task branch alone fails the atomic push without fencing the run', async () => {
  const { clones, remote } = world(1)
  const [a] = clones
  sh(a!.path, 'checkout', '-qb', 'work')
  writeFileSync(join(a!.path, 'w.txt'), 'w\n')
  sh(a!.path, 'add', '.')
  sh(a!.path, 'commit', '-qm', 'w')
  // A stale lock on the branch, as a crashed receive leaves one: the remote's transaction fails on it, not on the run's ref.
  mkdirSync(join(remote, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(remote, 'refs', 'heads', 'work.lock'), '')
  const r = await pushLeased(a!.path, 'origin', 'run-x', commitOf(a!.path, a!.runDir), undefined, ['work'])
  expect(r).toMatchObject({ ok: false, fenced: false })
})

it("a refused takeover leaves this host's journal and train journal as they were", async () => {
  const { clones } = world(2)
  const [writer, taker] = clones
  const mirror = new JournalMirror(writer!.path, { remote: 'origin' }, 'run-x', writer!.runDir, async () => [], () => {})
  expect(await mirror.checkpoint('start')).toBe('pushed')
  writeFileSync(join(taker!.runDir, 'journal.jsonl'), 'LOCAL\n')
  writeFileSync(join(taker!.runDir, 'train.jsonl'), 'TRAIN\n')
  await expect(
    takeOver(taker!.path, 'origin', 'run-x', taker!.runDir, async () => {
      throw new Error('refused by the record hook')
    }, { steal: true }),
  ).rejects.toThrow(/refused by the record hook/)
  expect(readFileSync(join(taker!.runDir, 'journal.jsonl'), 'utf8')).toBe('LOCAL\n')
  expect(readFileSync(join(taker!.runDir, 'train.jsonl'), 'utf8')).toBe('TRAIN\n')
})
