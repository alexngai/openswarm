/**
 * Landing a run through a standalone train (docs/05 D2, as revised): the
 * client half. Each task branch with commits is pushed to the train's remote
 * and enqueued at its commit, with its board blockers; the run then follows
 * the train's events for its entries. A landed entry's worktree goes. An
 * ejected one is repaired here, by the member that wrote it, as B3's steps
 * run in the lead-hosted train: the remote target is merged into its branch,
 * a conflict goes to the resolver and a failed check to a repair, the result
 * is committed, pushed and enqueued again, up to `maxRepairs`; past them it is
 * ejected for good, branch and worktree kept. Every outcome, and each step,
 * is journaled in the run's own train journal with its evidence bundle (B4),
 * built here from the run's journal, which the train never sees.
 *
 * A cancelled run withdraws its queued entries, so the train lands nothing
 * of a run that was told to stop.
 */
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { connect } from 'node:net'
import { promisify } from 'node:util'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { MergeOutcome, SwarmGit, WorktreeInfo } from 'openswarm-git'
import { buildEvidence } from './evidence'
import type { SwarmJournal, SwarmJournalEvent } from './journal'
import { join } from 'node:path'
import { TrainStoppedError, markers, repairPrompt, resolverPrompt, type TrainConfig } from './train'
import type { TrainCard } from './train-service'
import type { ReportProgress, RunMember } from './topologies'
import type { MemberSpec } from './types'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()

export interface RemoteTrainDeps {
  repoRoot: string
  /** The run's train journal: its entries' steps, outcomes and evidence. */
  journal: SwarmJournal
  runEvents?: () => readonly SwarmJournalEvent[]
  tasks?: readonly { id: string; blockedBy: readonly string[] }[]
  owners: ReadonlyMap<string, { member: MemberSpec; prompt: string }>
  members?: readonly MemberSpec[]
  run: RunMember
  report?: ReportProgress
  signal?: AbortSignal
}

/** A connection to the train, authenticated as this swarm's client. */
async function dial(url: string, token: string): Promise<{ call: (method: string, params?: object) => Promise<any>; close: () => void }> {
  const colon = url.lastIndexOf(':')
  const socket = connect({ host: url.slice(0, colon), port: Number(url.slice(colon + 1)) })
  await once(socket, 'connect')
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  await transport.request('swarm/auth', { token })
  return { call: (method, params = {}) => transport.request(method, params), close: () => socket.destroy() }
}

/** Two remote URLs name one repository: equal, or one path resolving to the other. */
const sameRemote = (a: string, b: string) => a.replace(/\/+$|\.git$/g, '') === b.replace(/\/+$|\.git$/g, '')

export async function landRemote(git_: SwarmGit, config: TrainConfig, deps: RemoteTrainDeps): Promise<MergeOutcome> {
  const report = deps.report ?? (() => {})
  const remote = config.remote ?? 'origin'
  const maxRepairs = config.maxRepairs ?? 1
  let train = await dial(config.url!, config.token!)
  // A cancel ends a long-poll at once: the socket closes under it.
  const hangUp = () => train.close()
  deps.signal?.addEventListener('abort', hangUp, { once: true })
  const outcome = {
    targetBranch: '',
    merged: [] as MergeOutcome['merged'],
    conflicts: [] as MergeOutcome['conflicts'],
    empty: [] as MergeOutcome['empty'],
    withheld: [] as MergeOutcome['withheld'],
    landed: [] as NonNullable<MergeOutcome['landed']>,
    ejected: [] as NonNullable<MergeOutcome['ejected']>,
    repaired: [] as NonNullable<MergeOutcome['repaired']>,
    resolved: [] as NonNullable<MergeOutcome['resolved']>,
  }
  /** Each entry the run has in the train: its worktree, the id it was last enqueued as, its repairs. */
  const entries = new Map<string, { worktree: WorktreeInfo; id: string; repairs: number; settled: boolean }>()
  const byId = new Map<string, string>()
  try {
    const card = (await train.call('swarm/train/card')) as TrainCard
    outcome.targetBranch = card.target
    const ours = await git(deps.repoRoot, 'remote', 'get-url', remote).catch(() => '')
    if (card.remoteUrl === null || !sameRemote(ours, card.remoteUrl)) {
      throw new Error(`the train lands from ${card.remoteUrl ?? 'its own checkout'}, and this repository's ${remote} is ${ours || 'not set'}: point worktrees.train.remote at the train's remote`)
    }
    const branchOf = new Map(git_.list().map((w) => [w.taskKey, w.branch]))
    /** Push the branch and enqueue its commit: its id, and its state when the train already had it at that commit. */
    const enqueue = async (key: string, worktree: WorktreeInfo): Promise<{ id: string; state: string }> => {
      deps.signal?.throwIfAborted()
      await git(deps.repoRoot, 'push', '-q', '--no-verify', '--force', remote, `${worktree.branch}:refs/heads/${worktree.branch}`)
      const sha = await git(deps.repoRoot, 'rev-parse', worktree.branch)
      const blockedBy = (deps.tasks?.find((t) => t.id === key)?.blockedBy ?? []).flatMap((b) => branchOf.get(b) ?? [])
      const { id, state } = await train.call('swarm/train/enqueue', { branch: worktree.branch, sha, blockedBy })
      byId.set(id, key)
      await deps.journal.append('train/enqueued', { version: 1, key, branch: worktree.branch, commits: 0, tip: sha, created: Date.now(), blockedBy, priority: 0 })
      return { id, state }
    }
    for (const worktree of git_.list()) {
      if ((await git_.commitCount(worktree.branch)) === 0) {
        outcome.empty.push({ taskKey: worktree.taskKey, branch: worktree.branch })
        await git_.removeWorktree(worktree)
        continue
      }
      const { id, state } = await enqueue(worktree.taskKey, worktree)
      entries.set(worktree.taskKey, { worktree, id, repairs: 0, settled: state !== 'queued' })
      // The train already had it at this commit and is done with it: no event will come.
      if (state === 'landed') outcome.landed.push({ taskKey: worktree.taskKey, branch: worktree.branch, commits: await git_.commitCount(worktree.branch) })
      else if (state !== 'queued') outcome.ejected.push({ taskKey: worktree.taskKey, branch: worktree.branch, reason: `the train already ${state === 'withdrawn' ? 'withdrew' : 'ejected'} it at this commit` })
    }
    report(`train: ${entries.size} entr${entries.size === 1 ? 'y' : 'ies'} enqueued at ${config.url}`)

    const ownerOf = (key: string) => deps.owners.get(key)?.member ?? deps.members?.find((m) => m.name === key) ?? deps.members?.[0]
    const promptOf = (key: string) => {
      const prompt = deps.owners.get(key)?.prompt ?? ''
      return prompt === '' ? '' : `${prompt}\n\n`
    }
    const evidence = async (key: string, at: { outcome: 'landed' | 'ejected'; base: string; commit?: string; batch?: number; reason?: string }) => {
      const branch = entries.get(key)!.worktree.branch
      // The tip it landed on is the train's: fetched, so the diff can be read here.
      await git(deps.repoRoot, 'fetch', '-q', remote, `+refs/heads/${card.target}:refs/remotes/${remote}/${card.target}`).catch(() => undefined)
      const diff = await git_.diffStat(at.base, branch).catch(() => undefined)
      const landing = { key, branch, via: 'train' as const, at: Date.now(), ...at, ...(diff === undefined ? {} : { diff }) }
      await deps.journal.append('train/evidence', buildEvidence(landing, deps.runEvents?.() ?? [], deps.journal.events))
    }
    /**
     * Repair an ejected entry here and enqueue it again. False, and the entry
     * is ejected for good, when it is out of repairs, its step failed or
     * changed nothing, or its resolver left conflict markers or dropped the
     * target's tip; any error repairing it ends that entry, not the landing.
     */
    const repair = async (key: string, ejected: { kind: string; reason: string; failedCommand?: string; output?: string }): Promise<boolean> => {
      const e = entries.get(key)!
      const member = ownerOf(key)
      if (e.repairs >= maxRepairs || member === undefined || ejected.kind === 'moved' || ejected.kind === 'blocked') return false
      e.repairs++
      try {
        await git(deps.repoRoot, 'fetch', '-q', remote, `+refs/heads/${card.target}:refs/remotes/${remote}/${card.target}`)
        const tip = await git(deps.repoRoot, 'rev-parse', `refs/remotes/${remote}/${card.target}`)
        const before = await git(deps.repoRoot, 'rev-parse', e.worktree.branch)
        const files = await git_.mergeInto(e.worktree, tip)
        const step = files.length > 0 ? 'resolve' : 'repair'
        const prompt =
          step === 'resolve'
            ? resolverPrompt(promptOf(key), card.target, files)
            : repairPrompt(promptOf(key), card.target, `\`${ejected.failedCommand ?? ejected.reason}\`${ejected.output ? `\n\n${ejected.output}` : ''}`)
        const result = await deps.run(member, prompt, key, step).catch((error: unknown) => ({ stopReason: 'error', text: String(error) }) as any)
        let failed = result.stopReason === 'error' ? `the ${step} step failed: ${String(result.text).slice(0, 200)}` : undefined
        if (step === 'resolve' && failed === undefined) {
          const left = files.filter((file) => markers(join(e.worktree.path, file)))
          if (left.length > 0) failed = `conflict markers remain in ${left.join(', ')}`
          else {
            await git_.concludeMerge(e.worktree, `swarm: merge ${card.target} into ${e.worktree.branch} (resolved)`)
            // A resolver that aborted the merge itself left the tip out.
            if (!(await git_.contains(e.worktree.branch, tip))) failed = `${card.target}'s tip is not in the branch after the resolver`
          }
        }
        if (step === 'resolve' && failed !== undefined) await git_.abortMerge(e.worktree).catch(() => undefined)
        if (step === 'repair' && failed === undefined) await git_.autoCommit(e.worktree, `swarm: repair ${key} (train)`)
        if (failed === undefined && (await git(deps.repoRoot, 'rev-parse', e.worktree.branch)) === before) failed = `the ${step} changed nothing`
        await deps.journal.append(`train/${step}`, { version: 1, key, branch: e.worktree.branch, commits: 0, member: member.name, attempt: e.repairs, outcome: failed === undefined ? 'committed' : 'failed', failure: ejected.reason, ...(failed === undefined ? {} : { error: failed }) })
        report(`train: ${step} ${e.repairs} of ${key} by ${member.name}${failed === undefined ? '' : `: ${failed}`}`)
        if (failed !== undefined) return false
        if (step === 'resolve') outcome.resolved.push({ taskKey: key, branch: e.worktree.branch })
        const again = await enqueue(key, e.worktree)
        e.id = again.id
        return again.state === 'queued'
      } catch (error) {
        report(`train: repairing ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    let after = -1
    while ([...entries.values()].some((e) => !e.settled)) {
      deps.signal?.throwIfAborted()
      const { events, next } = await train.call('swarm/train/events', { afterSeq: after, waitMs: 30_000 })
      after = next
      for (const event of events as SwarmJournalEvent[]) {
        const d = event.data as any
        const key = byId.get(d.id)
        if (key === undefined || entries.get(key)!.id !== d.id) continue
        const e = entries.get(key)!
        if (event.type === 'shared/landed') {
          e.settled = true
          const commits = await git_.commitCount(e.worktree.branch).catch(() => 0)
          outcome.landed.push({ taskKey: key, branch: e.worktree.branch, commits })
          outcome.merged.push({ taskKey: key, branch: e.worktree.branch, commits })
          await deps.journal.append('train/landed', { version: 1, key, branch: e.worktree.branch, commits, batch: d.batch, commit: d.commit })
          await evidence(key, { outcome: 'landed', base: d.tip ?? `${d.commit}^`, commit: d.commit, batch: d.batch })
          report(`train: ${key} landed (${d.commit.slice(0, 8)})`)
          await git_.removeWorktree(e.worktree)
        } else if (event.type === 'shared/ejected' || (event.type === 'shared/withdrawn' && d.why === 'withdrawn')) {
          if (event.type === 'shared/ejected' && (await repair(key, d))) continue
          e.settled = true
          const reason = event.type === 'shared/ejected' ? `${d.kind}: ${d.reason}` : 'withdrawn from the train'
          outcome.ejected.push({ taskKey: key, branch: e.worktree.branch, reason })
          if (d.kind === 'conflict') outcome.conflicts.push({ taskKey: key, branch: e.worktree.branch })
          await deps.journal.append('train/ejected', { version: 1, key, branch: e.worktree.branch, commits: 0, reason })
          const tip = await git(deps.repoRoot, 'rev-parse', `refs/remotes/${remote}/${card.target}`).catch(() => '')
          await evidence(key, { outcome: 'ejected', base: tip || e.worktree.branch, reason })
          report(`train: ${key} ejected — ${reason}`)
        }
      }
    }
    for (const e of entries.values()) if (e.repairs > 0) outcome.repaired.push({ taskKey: e.worktree.taskKey, branch: e.worktree.branch, repairs: e.repairs })
    return outcome
  } catch (error) {
    // Stopped: nothing of this run lands after it, and every unsettled entry is withheld,
    // withdrawn over a fresh connection when a cancel closed the first.
    // ponytail: a batch already verifying still lands; withdraw only reaches queued entries.
    train.close()
    train = await dial(config.url!, config.token!).catch(() => train)
    for (const e of entries.values()) {
      if (e.settled) continue
      await train.call('swarm/train/withdraw', { id: e.id }).catch(() => undefined)
      outcome.withheld.push({ taskKey: e.worktree.taskKey, branch: e.worktree.branch })
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new TrainStoppedError(`landing through the train at ${config.url} stopped: ${message}`, { ...outcome, stopped: message }, { cause: error })
  } finally {
    deps.signal?.removeEventListener('abort', hangUp)
    train.close()
  }
}
