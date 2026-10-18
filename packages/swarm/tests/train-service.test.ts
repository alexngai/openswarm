/**
 * The standalone train (docs/05 D2, D3), keyless, over a real bare remote:
 * clients push branches and enqueue them; the train lands them by a verified,
 * non-forced push; a failing entry is bisected out, a pair failing only
 * together loses its second, a conflict is ejected; an outside push that
 * breaks the target pauses the queue; a target moved mid-batch is verified
 * again, not overwritten; a crash between push and journal recovers from
 * the remote; client tokens outlive a restart, revocations too.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TrainService } from '../src/train-service'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

/** A bare remote with main at a base commit, the train's own clone (detached), and a client clone. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-train-service-'))
  const remote = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const seed = join(dir, 'seed')
  execFileSync('git', ['clone', '-q', remote, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-qm', 'base')
  sh(seed, 'push', '-q', 'origin', 'HEAD:main')
  const trainRoot = join(dir, 'train')
  execFileSync('git', ['clone', '-q', remote, trainRoot])
  sh(trainRoot, 'checkout', '-q', '--detach')
  const client = join(dir, 'client')
  execFileSync('git', ['clone', '-q', remote, client])
  /** A branch off main with `files` written, pushed; its commit. */
  const branch = (name: string, files: Record<string, string>, from = 'origin/main') => {
    sh(client, 'fetch', '-q', 'origin')
    sh(client, 'checkout', '-q', '-B', name, from)
    for (const [path, text] of Object.entries(files)) writeFileSync(join(client, path), text)
    sh(client, 'add', '.')
    sh(client, 'commit', '-qm', name)
    sh(client, 'push', '-q', '-f', 'origin', `${name}:refs/heads/${name}`)
    return sh(client, 'rev-parse', 'HEAD')
  }
  const mainHas = (path: string) => {
    sh(seed, 'fetch', '-q', 'origin')
    return execFileSync('git', ['ls-tree', '--name-only', 'origin/main'], { cwd: seed, encoding: 'utf8' }).split('\n').includes(path)
  }
  return { dir, remote, seed, trainRoot, client, branch, mainHas }
}

const open = (w: ReturnType<typeof world>, checks: string[], extra: object = {}) => TrainService.open({ repoRoot: w.trainRoot, target: 'main', remote: 'origin', checks, ...extra })

/** One pass over whatever is ready, as the loop would take it. */
const passAll = async (train: TrainService) => {
  for (let i = 0; i < 6; i++) {
    const ready = (train as any).ready().slice(0, 4)
    if (ready.length === 0) return
    await train.pass(ready)
  }
}

const states = (train: TrainService) => Object.fromEntries(train.status().entries.map((e) => [e.branch, e.state]))

it('two clients land through one batch by a verified push, journaled after it', async () => {
  const w = world()
  const train = await open(w, ['test -f README.md'])
  await train.enqueue('laptop', { branch: 'a', sha: w.branch('a', { 'a.txt': 'a\n' }) })
  await train.enqueue('ci', { branch: 'b', sha: w.branch('b', { 'b.txt': 'b\n' }) })
  await passAll(train)
  expect(states(train)).toEqual({ a: 'landed', b: 'landed' })
  expect(w.mainHas('a.txt') && w.mainHas('b.txt')).toBe(true)
  const types = train.journal.events.map((e) => e.type)
  // The base is verified alone first; the landings come after the batch was verified and pushed.
  expect(types.indexOf('shared/baseline')).toBeLessThan(types.indexOf('shared/batch'))
  expect(types.lastIndexOf('shared/verified')).toBeLessThan(types.indexOf('shared/landed'))
})

it('a failing entry is bisected out while its batch-mates land; a pair that fails only together loses its second', async () => {
  const w = world()
  const train = await open(w, ['! test -f bad.txt', '! (test -f x.txt && test -f y.txt)'])
  await train.enqueue('laptop', { branch: 'good1', sha: w.branch('good1', { 'g1.txt': '1\n' }) })
  await train.enqueue('laptop', { branch: 'bad', sha: w.branch('bad', { 'bad.txt': 'x\n' }) })
  await train.enqueue('ci', { branch: 'x', sha: w.branch('x', { 'x.txt': 'x\n' }) })
  await train.enqueue('ci', { branch: 'y', sha: w.branch('y', { 'y.txt': 'y\n' }) })
  await passAll(train)
  expect(states(train)).toEqual({ good1: 'landed', bad: 'ejected', x: 'landed', y: 'ejected' })
  const ejected = train.journal.events.filter((e) => e.type === 'shared/ejected').map((e) => e.data as any)
  expect(ejected.map((e) => [e.id.split('@')[0], e.kind, e.failedCommand])).toEqual(
    expect.arrayContaining([
      ['laptop/bad', 'check', '! test -f bad.txt'],
      ['ci/y', 'check', '! (test -f x.txt && test -f y.txt)'],
    ]),
  )
  expect(w.mainHas('bad.txt') || w.mainHas('y.txt')).toBe(false)
})

it('a conflict is ejected as one; round-robin takes principals in turn', async () => {
  const w = world()
  const train = await open(w, ['true'], { batchSize: 2 })
  await train.enqueue('laptop', { branch: 'r1', sha: w.branch('r1', { 'README.md': 'one\n' }) })
  await train.enqueue('laptop', { branch: 'r2', sha: w.branch('r2', { 'README.md': 'two\n' }) })
  await train.enqueue('ci', { branch: 'c1', sha: w.branch('c1', { 'c.txt': 'c\n' }) })
  // laptop's first, then ci's, then laptop's second.
  expect((train as any).ready().map((e: any) => e.branch)).toEqual(['r1', 'c1', 'r2'])
  await passAll(train)
  expect(states(train)).toEqual({ r1: 'landed', c1: 'landed', r2: 'ejected' })
  expect(train.journal.events.find((e) => e.type === 'shared/ejected')!.data).toMatchObject({ kind: 'conflict' })
})

it('an outside push that breaks the target pauses the queue rather than ejecting it, until the target is fixed', async () => {
  const w = world()
  const train = await open(w, ['! test -f broken.txt'])
  // Someone pushes a break straight to main.
  writeFileSync(join(w.seed, 'broken.txt'), 'x\n')
  sh(w.seed, 'add', '.')
  sh(w.seed, 'commit', '-qm', 'outside break')
  sh(w.seed, 'push', '-q', 'origin', 'HEAD:main')
  await train.enqueue('laptop', { branch: 'a', sha: w.branch('a', { 'a.txt': 'a\n' }) })
  expect(await train.pass((train as any).ready())).toBe(false)
  expect(states(train)).toEqual({ a: 'queued' })
  // Fixed from outside: the new tip is verified alone, then the entry lands on it.
  sh(w.seed, 'rm', '-q', 'broken.txt')
  sh(w.seed, 'commit', '-qm', 'outside fix')
  sh(w.seed, 'push', '-q', 'origin', 'HEAD:main')
  await passAll(train)
  expect(states(train)).toEqual({ a: 'landed' })
  expect(train.journal.events.filter((e) => e.type === 'shared/baseline').map((e) => (e.data as any).passed)).toEqual([false, true])
})

it('a target moved while a batch verifies is not overwritten: the push is refused, nothing journaled, and the next pass lands on the new tip', async () => {
  const w = world()
  const marker = join(w.dir, 'moved-once')
  // The check moves main once, from outside, as another pusher would.
  const mover = `if [ ! -f ${marker} ]; then touch ${marker}; cd ${w.seed} && git pull -q origin main && echo m > m.txt && git add m.txt && git -c user.email=t@t -c user.name=t commit -qm outside && git push -q origin HEAD:main; fi; true`
  const train = await open(w, [mover])
  await train.enqueue('laptop', { branch: 'a', sha: w.branch('a', { 'a.txt': 'a\n' }) })
  await train.pass((train as any).ready())
  expect(states(train)).toEqual({ a: 'queued' })
  expect(train.journal.events.some((e) => e.type === 'shared/landed')).toBe(false)
  await passAll(train)
  expect(states(train)).toEqual({ a: 'landed' })
  expect(w.mainHas('m.txt') && w.mainHas('a.txt')).toBe(true)
})

it('an entry already in the target has landed: a train killed between its push and its journal recovers from the remote', async () => {
  const w = world()
  const sha = w.branch('a', { 'a.txt': 'a\n' })
  const train = await open(w, ['true'])
  await train.enqueue('laptop', { branch: 'a', sha })
  // As if the train had pushed it and died before journaling.
  sh(w.client, 'push', '-q', 'origin', `${sha}:refs/heads/main`)
  await passAll(train)
  expect(train.journal.events.find((e) => e.type === 'shared/landed')!.data).toMatchObject({ batch: -1 })
  expect(train.journal.events.some((e) => e.type === 'shared/verified')).toBe(false)
})

it('enqueue is idempotent, a newer commit supersedes a queued older one, a moved branch is ejected, and a client sees only its own entries', async () => {
  const w = world()
  const train = await open(w, ['true'])
  const first = w.branch('a', { 'a.txt': '1\n' })
  const one = await train.enqueue('laptop', { branch: 'a', sha: first })
  expect(await train.enqueue('laptop', { branch: 'a', sha: first })).toEqual(one)
  const second = w.branch('a', { 'a.txt': '2\n' })
  await train.enqueue('laptop', { branch: 'a', sha: second })
  expect(train.journal.events.find((e) => e.type === 'shared/withdrawn')!.data).toMatchObject({ id: one.id, why: 'superseded' })
  // ci enqueues b, then pushes b again without enqueueing it: the train finds it moved.
  const b = w.branch('b', { 'b.txt': '1\n' })
  await train.enqueue('ci', { branch: 'b', sha: b })
  w.branch('b', { 'b.txt': '2\n' })
  await passAll(train)
  expect(states(train)).toMatchObject({ a: 'landed', b: 'ejected' })
  const laptop = await train.events({ role: 'client', client: 'laptop' })
  expect(laptop.events.every((e) => String((e.data as any).id).startsWith('laptop/'))).toBe(true)
  expect(laptop.events.some((e) => e.type === 'shared/client' || e.type === 'shared/baseline')).toBe(false)
  await expect(train.withdraw('laptop', train.status().entries.find((e) => e.branch === 'b')!.id)).rejects.toThrow('no entry')
})

it('client tokens are journaled as hashes and outlive a restart; a revoked one stays refused', async () => {
  const w = world()
  const journalPath = join(w.dir, 'train.jsonl')
  const train = await open(w, ['true'], { journalPath })
  const token = await train.invite('laptop')
  const other = await train.invite('ci')
  await expect(train.invite('laptop')).rejects.toThrow('already invited')
  expect(train.principalOf(token)).toEqual({ role: 'client', client: 'laptop' })
  await train.revoke('ci')
  expect(JSON.stringify(train.journal.events)).not.toContain(token)
  const reopened = await open(w, ['true'], { journalPath })
  expect(reopened.principalOf(token)).toEqual({ role: 'client', client: 'laptop' })
  expect(reopened.principalOf(other)).toBeUndefined()
  expect(reopened.principalOf('made-up')).toBeUndefined()
})

it('refuses a checkout with the target checked out, and a train without checks', async () => {
  const w = world()
  await expect(TrainService.open({ repoRoot: w.seed, target: 'main', remote: 'origin', checks: ['true'] })).rejects.toThrow('give it a checkout of its own')
  await expect(open(w, [])).rejects.toThrow('at least one check')
  expect(existsSync(w.trainRoot)).toBe(true)
})
