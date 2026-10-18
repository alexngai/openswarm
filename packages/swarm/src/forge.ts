/**
 * Landing through a forge's merge queue (docs/05 D4): GitHub, through the
 * `gh` CLI. Each task branch with commits is pushed to the remote, opened as
 * a pull request against `base` with its landing evidence as the body, and
 * handed to the repository's merge queue (`gh pr merge --auto`, which queues
 * where the base requires one and merges once checks pass where it does
 * not). The run then waits up to `waitMs` for each: merged is landed (at
 * GitHub's merge commit), closed is ejected, still open is withheld, its pull
 * request left to the queue. Outcomes and their evidence go to the run's train
 * journal, as the trains' do, so `openswarm landings` shows them.
 *
 * The forge verifies with its own required checks; nothing here repairs a
 * pull request the queue rejects, which stays open for a person.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { MergeOutcome, SwarmGit } from 'openswarm-git'
import { buildEvidence, landingText, type LandingAt } from './evidence'
import type { SwarmJournal, SwarmJournalEvent } from './journal'
import type { ReportProgress } from './topologies'

const run = promisify(execFile)

export interface ForgeConfig {
  kind: 'github'
  /** Where branches are pushed (default `origin`), the GitHub repository's remote. */
  remote?: string
  /** The branch pull requests target (default `main`). */
  base?: string
  /** How the queue merges (default `merge`). */
  method?: 'merge' | 'squash' | 'rebase'
  /** How long to wait for the queue (default 2 hours); 0 opens and queues without waiting. */
  waitMs?: number
  /** How often to look (default 30 s). */
  pollMs?: number
  /** The CLI (default `OPENSWARM_GH_BIN`, else `gh` on PATH). */
  command?: string
}

export function validateForge(config: ForgeConfig): void {
  if (config.kind !== 'github') throw new Error(`worktrees.forge.kind must be github, not ${String(config.kind)}`)
  if (config.method !== undefined && !['merge', 'squash', 'rebase'].includes(config.method)) throw new Error('worktrees.forge.method must be merge, squash or rebase')
  for (const [name, value] of [['waitMs', config.waitMs], ['pollMs', config.pollMs]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`worktrees.forge.${name} must be a non-negative number`)
  }
}

export interface ForgeDeps {
  repoRoot: string
  journal: SwarmJournal
  runEvents?: () => readonly SwarmJournalEvent[]
  /** A task's subject, for its pull request's title. */
  subjectOf: (key: string) => string | undefined
  report?: ReportProgress
  signal?: AbortSignal
}

export async function landForge(git_: SwarmGit, config: ForgeConfig, deps: ForgeDeps): Promise<MergeOutcome> {
  const gh = config.command ?? process.env['OPENSWARM_GH_BIN'] ?? 'gh'
  const remote = config.remote ?? 'origin'
  const base = config.base ?? 'main'
  const report = deps.report ?? (() => {})
  const call = async (args: string[]) => (await run(gh, args, { cwd: deps.repoRoot, maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
  const git = async (...args: string[]) => (await run('git', args, { cwd: deps.repoRoot, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
  const outcome = {
    targetBranch: base,
    merged: [] as MergeOutcome['merged'],
    conflicts: [] as MergeOutcome['conflicts'],
    empty: [] as MergeOutcome['empty'],
    withheld: [] as MergeOutcome['withheld'],
    landed: [] as NonNullable<MergeOutcome['landed']>,
    ejected: [] as NonNullable<MergeOutcome['ejected']>,
  }
  const evidence = async (at: Omit<LandingAt, 'at' | 'via' | 'diff'>) => {
    const diff = await git_.diffStat(at.base, at.branch).catch(() => undefined)
    const landing: LandingAt = { ...at, via: 'forge', at: Date.now(), ...(diff === undefined ? {} : { diff }) }
    await deps.journal.append('train/evidence', buildEvidence(landing, deps.runEvents?.() ?? [], deps.journal.events))
  }
  const scratch = mkdtempSync(join(tmpdir(), 'openswarm-forge-'))
  /** Open pull requests: task key → number, branch. */
  const open = new Map<string, { number: string; branch: string; commits: number }>()
  try {
    await git('fetch', '-q', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`)
    const tip = await git('rev-parse', `refs/remotes/${remote}/${base}`)
    for (const worktree of git_.list()) {
      const key = worktree.taskKey
      const commits = await git_.commitCount(worktree.branch)
      if (commits === 0) {
        outcome.empty.push({ taskKey: key, branch: worktree.branch })
        await git_.removeWorktree(worktree)
        continue
      }
      deps.signal?.throwIfAborted()
      await git('push', '-q', '--no-verify', '--force', remote, `${worktree.branch}:refs/heads/${worktree.branch}`)
      // The body is the evidence a reviewer reads: what the gate measured, the diff, the cost.
      const diff = await git_.diffStat(tip, worktree.branch).catch(() => undefined)
      const preview = buildEvidence({ key, outcome: 'landed', via: 'forge', branch: worktree.branch, base: tip, at: Date.now(), ...(diff === undefined ? {} : { diff }) }, deps.runEvents?.() ?? [], deps.journal.events)
      const body = join(scratch, `${key}.md`)
      writeFileSync(body, `Landed by an OpenSwarm run through the merge queue.\n\n\`\`\`\n${landingText(preview).join('\n')}\n\`\`\`\n`)
      const title = deps.subjectOf(key) ?? key
      const url = await call(['pr', 'create', '--base', base, '--head', worktree.branch, '--title', title, '--body-file', body])
      const number = /\/pull\/(\d+)/.exec(url)?.[1]
      if (number === undefined) throw new Error(`gh pr create gave no pull request URL: ${url}`)
      await call(['pr', 'merge', number, '--auto', `--${config.method ?? 'merge'}`])
      await deps.journal.append('train/enqueued', { version: 1, key, branch: worktree.branch, commits, tip, created: Date.now(), blockedBy: [], priority: 0 })
      report(`forge: ${key} is pull request #${number}, queued to merge into ${base}`)
      open.set(key, { number, branch: worktree.branch, commits })
    }
    const deadline = Date.now() + (config.waitMs ?? 2 * 60 * 60_000)
    while (open.size > 0) {
      for (const [key, pr] of [...open]) {
        const view = JSON.parse(await call(['pr', 'view', pr.number, '--json', 'state,mergeCommit'])) as { state: string; mergeCommit?: { oid?: string } | null }
        if (view.state === 'MERGED') {
          const commit = view.mergeCommit?.oid ?? ''
          outcome.landed.push({ taskKey: key, branch: pr.branch, commits: pr.commits })
          outcome.merged.push({ taskKey: key, branch: pr.branch, commits: pr.commits })
          await deps.journal.append('train/landed', { version: 1, key, branch: pr.branch, commits: pr.commits, batch: Number(pr.number), commit })
          await evidence({ key, outcome: 'landed', branch: pr.branch, base: tip, commit })
          report(`forge: #${pr.number} (${key}) merged`)
          open.delete(key)
          const worktree = git_.list().find((w) => w.taskKey === key)
          if (worktree !== undefined) await git_.removeWorktree(worktree)
        } else if (view.state === 'CLOSED') {
          const reason = `pull request #${pr.number} was closed without merging`
          outcome.ejected.push({ taskKey: key, branch: pr.branch, reason })
          await deps.journal.append('train/ejected', { version: 1, key, branch: pr.branch, commits: pr.commits, reason })
          await evidence({ key, outcome: 'ejected', branch: pr.branch, base: tip, reason })
          report(`forge: #${pr.number} (${key}) closed`)
          open.delete(key)
        }
      }
      if (open.size === 0 || Date.now() >= deadline) break
      deps.signal?.throwIfAborted()
      await new Promise((resolve) => setTimeout(resolve, config.pollMs ?? 30_000))
    }
    // Still in the queue: left to it, its pull request open.
    for (const [key, pr] of open) {
      outcome.withheld.push({ taskKey: key, branch: pr.branch })
      report(`forge: #${pr.number} (${key}) still queued; left to the merge queue`)
    }
    return outcome
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
