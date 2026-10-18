/**
 * The standalone train (docs/05 D2 and D3, as revised): one long-lived queue
 * per target branch, in a checkout of its own, that lands branches swarms on
 * any host enqueue, through the protocol, as `client` principals the owner
 * invited.
 *
 * An entry is a branch pinned to the commit it was enqueued at, keyed by its
 * principal and branch; enqueueing is idempotent on (principal, branch,
 * commit), and a newer commit for the same branch supersedes a queued older
 * one. Ready entries (their own blockers landed) are taken round-robin across
 * principals, up to `batchSize`, merged onto the target's tip in the train's
 * worktree, and verified once; a pass lands by a plain, non-forced push of
 * the verified commit (an update-ref compare-and-set on one host), journaled
 * only after it succeeded. A rejected push means someone else moved the
 * target: nothing is journaled, and the next pass fetches and verifies again.
 * A failing batch is bisected, as B2's is: each half lands on the then-current
 * tip, a lone failing entry is ejected with the failure, and a conflicting one
 * is ejected as a conflict. Repairs belong to the swarm that enqueued it (its
 * member wrote the work), so the train runs no agent: an ejected entry goes
 * back to its client, which can repair it and enqueue again.
 *
 * The remote target is the truth: an entry whose commit the target already
 * contains has landed, which is how a train killed between a push and its
 * journal recovers; and a tip the train did not push itself is verified alone
 * first, so a broken outside push pauses the queue rather than ejecting it.
 *
 * Entrants' code runs in the checks, as the train's user. Each check runs in
 * a disposable copy of the batch tree (its own repository, with no remote),
 * with credentials and the launcher's routes scrubbed from its environment
 * and a timeout. That stops accidents, not an adversary: v1 admits only the
 * clients the owner invites. Client tokens are journaled as hashes, with
 * revocations, so they outlive a restart.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { linkIgnored, withSnapshotClone } from 'openswarm-git'
import { cliEnv } from './cli-runtime'
import { SwarmJournal, type SwarmJournalEvent } from './journal'
import type { Principal } from './protocol'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
const ok = (p: Promise<unknown>) => p.then(() => true, () => false)
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export interface TrainServiceConfig {
  /** A checkout of the repository for the train alone; its target must not be checked out there. */
  repoRoot: string
  target: string
  /** The shared remote: entries are fetched from it and the target pushed to it. None on one host. */
  remote?: string
  /** What every batch tree must pass (L2). */
  checks: string[]
  /** Entries merged and verified together (default 4). */
  batchSize?: number
  /** One check's bound (default 10 minutes). */
  checkTimeoutMs?: number
  /** The train's journal (default `<repoRoot>/.swarm/train-service/<target>.jsonl`). */
  journalPath?: string
  report?: (line: string) => void
}

export type EjectKind = 'conflict' | 'check' | 'moved'

/** Payloads of the train's journal (its own file, not a run's). */
export interface TrainServiceEvents {
  /** An invited client; its token only as a hash. */
  'shared/client': { version: 1; name: string; hash: string }
  'shared/revoked': { version: 1; name: string }
  'shared/enqueued': { version: 1; id: string; principal: string; branch: string; sha: string; blockedBy: string[]; epoch?: number }
  /** Withdrawn by its client, or superseded by a newer commit of the same branch. */
  'shared/withdrawn': { version: 1; id: string; why: 'withdrawn' | 'superseded' }
  'shared/baseline': { version: 1; tip: string; passed: boolean; failedCommand?: string }
  'shared/batch': { version: 1; batch: number; tip: string; ids: string[] }
  'shared/verified': { version: 1; batch: number; commit: string; passed: boolean; failedCommand?: string }
  /** Landed: `commit` is the target once it did; `batch` -1 when found in the target on recovery. */
  'shared/landed': { version: 1; id: string; batch: number; commit: string }
  'shared/ejected': { version: 1; id: string; kind: EjectKind; reason: string; failedCommand?: string; output?: string }
}

type State = 'queued' | 'landed' | 'ejected' | 'withdrawn'

interface Entry {
  id: string
  principal: string
  branch: string
  sha: string
  blockedBy: string[]
  epoch?: number
  seq: number
  state: State
}

/** The train's card: what a client needs to land through it. */
export interface TrainCard {
  target: string
  remote: string | null
  remoteUrl: string | null
  checks: string[]
  batchSize: number
}

export class TrainService {
  private readonly entries = new Map<string, Entry>()
  /** Client token hashes → name, revoked ones removed. */
  private readonly clients = new Map<string, string>()
  private batches = 0
  /** The target this train last pushed, and tips already verified alone. */
  private pushed: string | undefined
  private readonly baselines = new Map<string, boolean>()
  private readonly work: string
  private readonly report: (line: string) => void

  private constructor(
    readonly config: TrainServiceConfig,
    readonly journal: SwarmJournal,
    private readonly remoteUrl: string | null,
  ) {
    this.work = join(config.repoRoot, '.swarm', 'train-service', `work-${config.target.replace(/[^\w.-]/g, '-')}`)
    this.report = config.report ?? (() => {})
    for (const event of journal.events) this.fold(event)
  }

  /** Open (or resume) the train for `config.target`: its journal folded, its worktree ready. */
  static async open(config: TrainServiceConfig): Promise<TrainService> {
    if (config.checks.length === 0) throw new Error('a train needs at least one check its batches must pass')
    const head = await git(config.repoRoot, 'symbolic-ref', '-q', 'HEAD').catch(() => '')
    if (head === `refs/heads/${config.target}`) {
      throw new Error(`the train's checkout has ${config.target} checked out; give it a checkout of its own, where the train alone moves the target`)
    }
    const remoteUrl = config.remote === undefined ? null : await git(config.repoRoot, 'remote', 'get-url', config.remote)
    const journal = SwarmJournal.open(config.journalPath ?? join(config.repoRoot, '.swarm', 'train-service', `${config.target.replace(/[^\w.-]/g, '-')}.jsonl`))
    const train = new TrainService(config, journal, remoteUrl)
    const tip = await train.syncTip()
    if (!existsSync(train.work)) {
      await git(config.repoRoot, 'worktree', 'add', '-q', '--detach', train.work, tip)
      // The checks build and test in copies of this tree, which take its ignored environment.
      await linkIgnored(config.repoRoot, train.work)
    }
    return train
  }

  private fold(event: SwarmJournalEvent): void {
    const d = event.data as any
    switch (event.type) {
      case 'shared/client':
        this.clients.set(d.hash, d.name)
        break
      case 'shared/revoked':
        for (const [h, name] of this.clients) if (name === d.name) this.clients.delete(h)
        break
      case 'shared/enqueued':
        this.entries.set(d.id, { id: d.id, principal: d.principal, branch: d.branch, sha: d.sha, blockedBy: d.blockedBy, ...(d.epoch === undefined ? {} : { epoch: d.epoch }), seq: event.seq, state: 'queued' })
        break
      case 'shared/withdrawn':
        this.mark(d.id, 'withdrawn')
        break
      case 'shared/ejected':
        this.mark(d.id, 'ejected')
        break
      case 'shared/landed':
        this.mark(d.id, 'landed')
        if (d.batch >= 0) this.pushed = d.commit
        break
      case 'shared/batch':
        this.batches = Math.max(this.batches, d.batch)
        break
      case 'shared/baseline':
        this.baselines.set(d.tip, d.passed)
        break
    }
  }

  private mark(id: string, state: State): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) entry.state = state
  }

  private async record<K extends keyof TrainServiceEvents>(type: K, data: Omit<TrainServiceEvents[K], 'version'>): Promise<void> {
    this.fold(await this.journal.append(type, { version: 1, ...data }))
  }

  card(): TrainCard {
    return { target: this.config.target, remote: this.config.remote ?? null, remoteUrl: this.remoteUrl, checks: [...this.config.checks], batchSize: this.config.batchSize ?? 4 }
  }

  /** Invite a client: a new token for it, journaled as a hash; returned once, here. */
  async invite(name: string): Promise<string> {
    if (!/^[\w.-]{1,64}$/.test(name)) throw new Error('a client name is 1-64 of [A-Za-z0-9_.-]')
    if ([...this.clients.values()].includes(name)) throw new Error(`a client named "${name}" is already invited; revoke it first`)
    const token = randomBytes(32).toString('base64url')
    await this.record('shared/client', { name, hash: hash(token) })
    return token
  }

  async revoke(name: string): Promise<void> {
    if (![...this.clients.values()].includes(name)) throw new Error(`no client named "${name}"`)
    await this.record('shared/revoked', { name })
  }

  /** The client a token belongs to, unless revoked. */
  principalOf(token: string): Principal | undefined {
    const name = this.clients.get(hash(token))
    return name === undefined ? undefined : { role: 'client', client: name }
  }

  /**
   * Enqueue `branch` at `sha` for `principal`. The same branch and commit
   * again is the same entry; a newer commit supersedes a queued older one.
   * `blockedBy` names the principal's own branches that must land first.
   */
  async enqueue(principal: string, input: { branch: string; sha: string; blockedBy?: string[]; epoch?: number }): Promise<{ id: string; state: State }> {
    if (!/^[\w./-]{1,200}$/.test(input.branch) || input.branch.includes('..')) throw new Error(`invalid branch "${input.branch}"`)
    if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new Error('sha must be a full commit id')
    const id = `${principal}/${input.branch}@${input.sha.slice(0, 12)}`
    const existing = this.entries.get(id)
    if (existing !== undefined) return { id, state: existing.state }
    for (const older of this.entries.values()) {
      if (older.principal === principal && older.branch === input.branch && older.state === 'queued') await this.record('shared/withdrawn', { id: older.id, why: 'superseded' })
    }
    await this.record('shared/enqueued', {
      id,
      principal,
      branch: input.branch,
      sha: input.sha,
      blockedBy: (input.blockedBy ?? []).map(String),
      ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    })
    this.report(`train: enqueued ${id}`)
    return { id, state: 'queued' }
  }

  async withdraw(principal: string, id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined || (entry.principal !== principal && principal !== 'owner')) throw new Error(`no entry "${id}" of yours`)
    if (entry.state === 'queued') await this.record('shared/withdrawn', { id, why: 'withdrawn' })
  }

  /**
   * The journal after `afterSeq`, waiting up to `waitMs` for some: everything
   * for the owner; for a client, only what is about its own entries, and never
   * another principal's or the client list.
   */
  async events(principal: Principal, afterSeq = -1, waitMs = 0): Promise<{ events: SwarmJournalEvent[]; next: number }> {
    const visible = (e: SwarmJournalEvent) =>
      principal.role === 'owner' ||
      (principal.role === 'client' && typeof (e.data as any)?.id === 'string' && this.entries.get((e.data as any).id)?.principal === principal.client)
    const pick = () => this.journal.events.filter((e) => e.seq > afterSeq && visible(e))
    let events = pick()
    for (const end = Date.now() + Math.min(waitMs, 60_000); events.length === 0 && Date.now() < end; events = pick()) {
      await this.journal.waitForAppend(this.journal.events.at(-1)?.seq ?? -1, end - Date.now())
    }
    return { events, next: this.journal.events.at(-1)?.seq ?? afterSeq }
  }

  /** Queued entries whose own blockers have landed, round-robin across principals, each in enqueue order. */
  private ready(): Entry[] {
    const landed = (principal: string, branch: string) => {
      const latest = [...this.entries.values()].filter((e) => e.principal === principal && e.branch === branch).sort((a, b) => b.seq - a.seq)[0]
      return latest === undefined || latest.state === 'landed'
    }
    const queues = new Map<string, Entry[]>()
    for (const e of [...this.entries.values()].sort((a, b) => a.seq - b.seq)) {
      if (e.state === 'queued' && e.blockedBy.every((b) => landed(e.principal, b))) queues.set(e.principal, [...(queues.get(e.principal) ?? []), e])
    }
    const order: Entry[] = []
    for (let i = 0; order.length < [...queues.values()].flat().length; i++) for (const q of queues.values()) if (q[i] !== undefined) order.push(q[i]!)
    return order
  }

  /** Land until `signal` aborts: one batch at a time, waiting for work when there is none. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const batch = this.ready().slice(0, this.config.batchSize ?? 4)
      if (batch.length === 0) {
        await this.journal.waitForAppend(this.journal.events.at(-1)?.seq ?? -1, 5_000)
        continue
      }
      try {
        const progressed = await this.pass(batch)
        // A paused queue (a failing outside tip) waits for the tip to change.
        if (!progressed) await new Promise((r) => setTimeout(r, 5_000).unref())
      } catch (error) {
        this.report(`train: pass failed: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise((r) => setTimeout(r, 5_000).unref())
      }
    }
  }

  /** One pass over `batch`; false when the queue is paused on a failing tip. */
  async pass(batch: Entry[]): Promise<boolean> {
    const tip = await this.syncTip()
    // Already in the target: landed, whether by this train before a crash or by hand.
    const live: Entry[] = []
    for (const e of batch) {
      if (await ok(git(this.config.repoRoot, 'merge-base', '--is-ancestor', e.sha, tip))) await this.record('shared/landed', { id: e.id, batch: -1, commit: tip })
      else live.push(e)
    }
    if (live.length === 0) return true
    if (!(await this.baseline(tip))) return false
    const fetched: Entry[] = []
    for (const e of live) {
      if (await this.fetchEntry(e)) fetched.push(e)
      else await this.record('shared/ejected', { id: e.id, kind: 'moved', reason: `${e.branch} is no longer at ${e.sha.slice(0, 12)}; enqueue its current commit` })
    }
    await this.land(fetched, tip)
    return true
  }

  /** Land `entries` on `tip`, bisecting a failing batch. */
  private async land(entries: Entry[], tip: string): Promise<void> {
    if (entries.length === 0) return
    const batch = ++this.batches
    await this.record('shared/batch', { batch, tip, ids: entries.map((e) => e.id) })
    const { commit, conflicted } = await this.speculate(tip, entries)
    for (const e of conflicted) await this.record('shared/ejected', { id: e.id, kind: 'conflict', reason: `merging ${e.branch} onto ${this.config.target} conflicts` })
    const clean = entries.filter((e) => !conflicted.includes(e))
    if (clean.length === 0) return
    const verdict = await this.verify(commit)
    await this.record('shared/verified', { batch, commit, passed: verdict.passed, ...(verdict.failedCommand === undefined ? {} : { failedCommand: verdict.failedCommand }) })
    if (verdict.passed) {
      if (!(await this.push(commit, tip))) {
        this.report(`train: ${this.config.target} moved during batch ${batch}; it is verified again on the new tip`)
        return
      }
      for (const e of clean) await this.record('shared/landed', { id: e.id, batch, commit })
      this.report(`train: batch ${batch} landed ${clean.map((e) => e.id).join(', ')}`)
      return
    }
    if (clean.length === 1) {
      await this.record('shared/ejected', { id: clean[0]!.id, kind: 'check', reason: `fails on ${this.config.target} with it merged: ${verdict.failedCommand}`, failedCommand: verdict.failedCommand!, output: verdict.output ?? '' })
      return
    }
    const half = Math.ceil(clean.length / 2)
    await this.land(clean.slice(0, half), tip)
    await this.land(clean.slice(half), await this.syncTip())
  }

  /** The target's tip, fetched first from the remote when there is one. */
  private async syncTip(): Promise<string> {
    const { remote, target, repoRoot } = this.config
    if (remote === undefined) return git(repoRoot, 'rev-parse', `refs/heads/${target}`)
    await git(repoRoot, 'fetch', '-q', remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`)
    return git(repoRoot, 'rev-parse', `refs/remotes/${remote}/${target}`)
  }

  /** Bring an entry's commit here; false when its branch is no longer at it. */
  private async fetchEntry(e: Entry): Promise<boolean> {
    const { remote, repoRoot } = this.config
    if (remote !== undefined && !(await ok(git(repoRoot, 'fetch', '-q', remote, `+refs/heads/${e.branch}:refs/train-service/${e.principal}/${e.branch}`)))) return false
    const at = await git(repoRoot, 'rev-parse', remote === undefined ? `refs/heads/${e.branch}` : `refs/train-service/${e.principal}/${e.branch}`).catch(() => '')
    return at === e.sha
  }

  /** A tip this train did not push is verified alone before anything lands on it. */
  private async baseline(tip: string): Promise<boolean> {
    if (tip === this.pushed) return true
    const known = this.baselines.get(tip)
    if (known !== undefined) return known
    const verdict = await this.verify(tip)
    await this.record('shared/baseline', { tip, passed: verdict.passed, ...(verdict.failedCommand === undefined ? {} : { failedCommand: verdict.failedCommand }) })
    if (!verdict.passed) this.report(`train: ${this.config.target} at ${tip.slice(0, 8)} fails ${verdict.failedCommand} before anything lands; paused until it changes`)
    return verdict.passed
  }

  /** `entries` merged `--no-ff`, in order, onto `tip` in the train's worktree; conflicting ones left out. */
  private async speculate(tip: string, entries: Entry[]): Promise<{ commit: string; conflicted: Entry[] }> {
    const w = this.work
    await git(w, '-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '-f', '--detach', tip)
    await git(w, 'clean', '-fdq')
    const conflicted: Entry[] = []
    for (const e of entries) {
      const merged = await ok(git(w, '-c', 'user.email=train@openswarm', '-c', 'user.name=openswarm train', 'merge', '--no-ff', '--no-verify', '-q', '-m', `train: land ${e.branch} (${e.principal})`, e.sha))
      if (!merged) {
        await git(w, 'merge', '--abort').catch(() => git(w, 'reset', '-q', '--hard', 'HEAD'))
        conflicted.push(e)
      }
    }
    return { commit: await git(w, 'rev-parse', 'HEAD'), conflicted }
  }

  /**
   * Every check on `commit`, each in a disposable copy of it, with no remote,
   * credentials scrubbed and a timeout. ponytail: the timeout kills the check's
   * shell, not what it detached; and the copy hard-links the ignored
   * environment, so a check that rewrites a file there in place rewrites it
   * for the next batch too. Confining entrants needs B1's verifier user.
   */
  private async verify(commit: string): Promise<{ passed: boolean; failedCommand?: string; output?: string }> {
    const env = { ...cliEnv(() => false), GIT_TERMINAL_PROMPT: '0' }
    return withSnapshotClone(this.work, commit, async (cwd) => {
      for (const command of this.config.checks) {
        try {
          await run('bash', ['-c', command], { cwd, env, timeout: this.config.checkTimeoutMs ?? 600_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
        } catch (error) {
          const output = `${(error as any)?.stdout ?? ''}${(error as any)?.stderr ?? ''}`
          return { passed: false, failedCommand: command, output: output.slice(-4_000) }
        }
      }
      return { passed: true }
    })
  }

  /** Land `commit` by moving the target from `tip` to it: a non-forced push, or a compare-and-set on one host. */
  private async push(commit: string, tip: string): Promise<boolean> {
    const { remote, target, repoRoot } = this.config
    if (remote === undefined) return ok(git(repoRoot, 'update-ref', `refs/heads/${target}`, commit, tip))
    if (!(await ok(git(repoRoot, 'push', '-q', '--no-verify', remote, `${commit}:refs/heads/${target}`)))) return false
    await git(repoRoot, 'update-ref', `refs/remotes/${remote}/${target}`, commit)
    return true
  }

  /** What is queued, landed and ejected, for the owner's view. */
  status(): { entries: Omit<Entry, 'seq'>[]; clients: string[] } {
    return { entries: [...this.entries.values()].map(({ seq: _seq, ...e }) => e), clients: [...new Set(this.clients.values())] }
  }
}
