/**
 * Durable runs across hosts (docs/05 D1, as revised): a run's journal lives
 * on the shared remote under `refs/swarm/<runId>`, so a run outlives its host.
 *
 * The writer mirrors: each push is a commit whose tree holds the run's
 * journals, pushed with the task branches of its completed tasks in one
 * atomic push that names the ref's expected object (`--force-with-lease=
 * refs/swarm/<id>:<oid>`, never the remote-tracking ref a fetch moves). Pushes
 * come at checkpoints (a task completing, the run about to land) and as
 * heartbeats. A push refused for that ref means another host took the run
 * over: the writer is fenced, stops, and lands nothing. A transport error is
 * not a fence and is retried at the next push, but starting and landing
 * `confirm`: they need a push that landed, since a writer cut off from the
 * remote may have been taken over.
 *
 * A taker fetches the ref, waits a lease (the ref unchanged for `ttlMs`, as it
 * observes it) unless it steals, writes the journal locally, records the run
 * taken over, and pushes that with the observed object as the lease: of two
 * takers, one wins. ponytail: the lease is the taker's own clock over the
 * writer's heartbeats; a writer paused longer than the TTL is taken over and
 * fenced at its next push, by design.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const git = async (cwd: string, args: string[], input?: string) => {
  const child = run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  if (input !== undefined) {
    child.child.stdin?.end(input)
  }
  return (await child).stdout.trim()
}

export interface DurableConfig {
  /** The shared remote the run's journal and task branches are pushed to. */
  remote: string
  /** How often the writer pushes when nothing else made it (default 30 s, at most 30 s: a taker's lease is 90 s). */
  heartbeatMs?: number
}

export function validateDurable(config: DurableConfig): void {
  if (typeof config.remote !== 'string' || config.remote === '') throw new Error('durable.remote must name a git remote')
  const beat = config.heartbeatMs
  if (beat !== undefined && (!Number.isFinite(beat) || beat <= 0 || beat > 30_000)) throw new Error('durable.heartbeatMs must be over 0 and at most 30000, a third of a taker\'s lease')
}

/** What a push did: landed, refused because another host holds the run, or did not reach the remote. */
export type Pushed = 'pushed' | 'fenced' | 'unreachable'

export const runRef = (runId: string) => `refs/swarm/${runId}`

export type PushResult = { ok: true; oid: string } | { ok: false; fenced: boolean; why: string }

/** The run's journals as a commit, parented on `parent`, without touching any worktree. */
async function snapshot(repoRoot: string, runDir: string, parent: string | undefined, message: string): Promise<string> {
  const entries: string[] = []
  for (const name of ['journal.jsonl', 'train.jsonl']) {
    const path = join(runDir, name)
    if (!existsSync(path)) continue
    const blob = await git(repoRoot, ['hash-object', '-w', path])
    entries.push(`100644 blob ${blob}\t${name}`)
  }
  const tree = await git(repoRoot, ['mktree'], `${entries.join('\n')}\n`)
  return git(repoRoot, ['-c', 'user.email=swarm@openswarm', '-c', 'user.name=openswarm', 'commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', message])
}

/**
 * One atomic push of the run's ref and `branches`, leased on the ref being at
 * `expected` (absent when undefined). Fenced when the remote refused the ref
 * for its lease; any other failure is a transport error.
 */
export async function pushLeased(repoRoot: string, remote: string, runId: string, commit: string, expected: string | undefined, branches: readonly string[] = []): Promise<PushResult> {
  const ref = runRef(runId)
  const args = ['push', '--atomic', '--porcelain', '--no-verify', `--force-with-lease=${ref}:${expected ?? ''}`, remote, `${commit}:${ref}`, ...branches.map((b) => `+${b}:refs/heads/${b}`)]
  try {
    await git(repoRoot, args)
    return { ok: true, oid: commit }
  } catch (error) {
    const out = `${(error as any)?.stdout ?? ''}\n${(error as any)?.stderr ?? ''}`
    // Porcelain marks a refused ref "!": for the leased ref, its lease failed
    // ("[rejected] (stale info)") or a concurrent writer won the remote's ref
    // transaction ("[remote rejected] (cannot lock ref …)", "(atomic
    // transaction failed)"). Either way another host holds the run. Nothing else fences: a transport failure refuses no
    // ref by name, and a hook declining the push, or a branch failing the
    // atomic push, refuses the run's ref for a reason that is not another host.
    const fenced = out.split('\n').some((line) => line.startsWith('!') && line.includes(`:${ref}\t`) && /stale info|cannot lock ref|failed to update ref|incorrect old value|atomic transaction failed/.test(line))
    return { ok: false, fenced, why: out.trim().split('\n').filter((l) => l !== '' && !l.startsWith('To ')).slice(-3).join(' ') }
  }
}

/** The run's ref on the remote: its object, or undefined when it has none. */
export async function remoteRunOid(repoRoot: string, remote: string, runId: string): Promise<string | undefined> {
  const line = await git(repoRoot, ['ls-remote', remote, runRef(runId)])
  return line === '' ? undefined : line.split(/\s+/)[0]
}

/** The writer's half: mirror the run's journals to the remote, leased, until fenced or stopped. */
export class JournalMirror {
  private lease: string | undefined
  private fenced = false
  private stopped = false
  private timer: ReturnType<typeof setInterval> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly repoRoot: string,
    private readonly config: DurableConfig,
    private readonly runId: string,
    private readonly runDir: string,
    /** The branches to push with the journal: completed tasks', committed first. */
    private readonly branches: () => Promise<string[]>,
    private readonly onFenced: (why: string) => void,
    /** The ref's object as the writer last saw it: a taker's own takeover commit, else none. */
    lease?: string,
  ) {
    this.lease = lease
  }

  get isFenced(): boolean {
    return this.fenced
  }

  /** Push now, after any push in flight. Once fenced or stopped, nothing is pushed. */
  checkpoint(why: string): Promise<Pushed> {
    const next = this.queue.then(() => this.push(why))
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * A push that must land: tried `tries` times while the remote is
   * unreachable. True only when it landed, so the run still holds its lease
   * (what landing and starting require: a writer cut off from the remote may
   * have been taken over, and a mistyped remote would mirror nothing).
   */
  async confirm(why: string, tries = 3): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      const pushed = await this.checkpoint(why)
      if (pushed !== 'unreachable') return pushed === 'pushed'
      if (this.stopped) return false
      if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)))
    }
    return false
  }

  private async push(why: string): Promise<Pushed> {
    if (this.fenced || this.stopped) return 'fenced'
    let result: PushResult
    try {
      const commit = await snapshot(this.repoRoot, this.runDir, this.lease, `swarm: ${this.runId} ${why}`)
      result = await pushLeased(this.repoRoot, this.config.remote, this.runId, commit, this.lease, await this.branches())
    } catch (error) {
      result = { ok: false, fenced: false, why: error instanceof Error ? error.message : String(error) }
    }
    if (result.ok) {
      this.lease = result.oid
      return 'pushed'
    }
    if (result.fenced) {
      this.fenced = true
      this.stop()
      this.onFenced(`another host took run ${this.runId} over (${result.why})`)
      return 'fenced'
    }
    // A transport error: the next push tries again.
    return 'unreachable'
  }

  start(): void {
    if (this.stopped) return
    const every = this.config.heartbeatMs ?? 30_000
    this.timer = setInterval(() => void this.checkpoint('heartbeat'), every)
    this.timer.unref?.()
  }

  /** No more pushes, queued ones included. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}

/**
 * Take a run over from the remote (D1): fetch its ref, wait out the writer's
 * lease unless `steal`, write its journals into `runDir`, let `record` append
 * the takeover to them, and push that leased on the object fetched. Resolves
 * to the new lease; throws when the writer is alive or another taker won.
 */
export async function takeOver(
  repoRoot: string,
  remote: string,
  runId: string,
  runDir: string,
  record: () => Promise<void>,
  options: { steal?: boolean; ttlMs?: number } = {},
): Promise<string> {
  const ref = runRef(runId)
  const fetch = async () => {
    await git(repoRoot, ['fetch', '-q', remote, `+${ref}:${ref}`])
    return git(repoRoot, ['rev-parse', ref])
  }
  const observed = await fetch().catch(() => {
    throw new Error(`the remote ${remote} has no ${ref}: the run was never mirrored there`)
  })
  if (options.steal !== true) {
    await new Promise((resolve) => setTimeout(resolve, options.ttlMs ?? 90_000))
    if ((await fetch()) !== observed) throw new Error(`run ${runId}'s writer is alive (its ref moved during the lease); pass --steal to take it anyway`)
  }
  mkdirSync(runDir, { recursive: true })
  for (const name of ['journal.jsonl', 'train.jsonl']) {
    const text = await git(repoRoot, ['show', `${observed}:${name}`]).catch(() => undefined)
    if (text !== undefined) writeFileSync(join(runDir, name), text === '' ? '' : `${text}\n`)
  }
  await record()
  const commit = await snapshot(repoRoot, runDir, observed, `swarm: ${runId} taken over`)
  const pushed = await pushLeased(repoRoot, remote, runId, commit, observed)
  if (!pushed.ok) throw new Error(pushed.fenced ? `another host took run ${runId} over first` : `pushing the takeover failed: ${pushed.why}`)
  return pushed.oid
}

/** Read a journal file's text, empty when absent (for tests and views). */
export const journalText = (runDir: string) => (existsSync(join(runDir, 'journal.jsonl')) ? readFileSync(join(runDir, 'journal.jsonl'), 'utf8') : '')
export const runDirOf = (journalPath: string) => dirname(journalPath)
