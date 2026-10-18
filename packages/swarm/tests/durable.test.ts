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
import { JournalMirror, pushLeased, remoteRunOid, takeOver } from '../src/durable'

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
  expect(await mirror.checkpoint('start')).toBe(true)
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
  // A second taker that observed the old object loses.
  execFileSync('git', ['fetch', '-q', 'origin', '+refs/swarm/run-x:refs/swarm/run-x'], { cwd: late!.path })
  // The old writer's next push is refused: fenced, it stops.
  expect(await mirror.checkpoint('after takeover')).toBe(false)
  expect(mirror.isFenced).toBe(true)
  expect(fenced[0]).toMatch(/another host took run run-x over/)
  expect(await mirror.checkpoint('again')).toBe(false)
})
