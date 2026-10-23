/**
 * docs/05 pilot: run a hand-written plan of threads, each a coordinator team in
 * git worktrees, under one of two scheduling arms.
 *
 * - `sharded`: every thread cut from the base commit, all run at once, all
 *   landed at the end in plan order.
 * - `program`: a thread starts once every `blockedBy` thread has LANDED, cut
 *   from the workspace's HEAD at that moment (so it sees landed work — thread
 *   0's contracts); each thread lands as soon as it finishes.
 *
 * Those rules are the ONLY difference between the arms: the caller supplies one
 * `runThread` for both. Landings are serialized, and a program thread's cut is
 * taken between landings, never during one.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd })).stdout.trim()

export const ARMS = ['sharded', 'program'] as const
export type Arm = (typeof ARMS)[number]

export interface PlanThread {
  id: string
  assignment: string
  blockedBy: string[]
}

export interface Plan {
  /** Workers per thread's coordinator team (default 2). */
  workers: number
  threads: PlanThread[]
}

export interface ThreadRecord {
  id: string
  /** The commit this thread's worktrees were cut from; null if it never started. */
  baseSha: string | null
  startMs: number | null
  endMs: number | null
  landed: 'merged' | 'conflict' | 'empty' | 'failed'
  /** Commits `pilot/<id>` carries beyond `baseSha`. */
  commits: number
  error?: string
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Read and validate a plan. Only `id`, `assignment`, `blockedBy` (and the
 * top-level `workers`) are ours; other fields, e.g. a patch splitter's `paths`
 * or `default`, belong to other tools and are ignored.
 */
export function loadPlan(path: string): Plan {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const fail = (why: string): never => {
    throw new Error(`plan ${path}: ${why}`)
  }
  if (!Array.isArray(raw?.threads) || raw.threads.length === 0) fail('"threads" must be a non-empty array')
  const ids = new Set<string>()
  const threads: PlanThread[] = raw.threads.map((t: any) => {
    // The id names a branch (`pilot/<id>`), so keep it to characters git accepts anywhere.
    if (typeof t?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(t.id)) fail(`thread id ${JSON.stringify(t?.id)} must match [A-Za-z0-9_-]+`)
    if (ids.has(t.id)) fail(`duplicate thread id "${t.id}"`)
    ids.add(t.id)
    if (typeof t.assignment !== 'string' || t.assignment.trim() === '') fail(`thread "${t.id}" needs an assignment`)
    const blockedBy = t.blockedBy ?? []
    if (!Array.isArray(blockedBy) || blockedBy.some((b: unknown) => typeof b !== 'string')) {
      fail(`thread "${t.id}" blockedBy must be an array of thread ids`)
    }
    return { id: t.id, assignment: t.assignment, blockedBy }
  })
  for (const t of threads) {
    for (const b of t.blockedBy) if (!ids.has(b)) fail(`thread "${t.id}" is blockedBy unknown thread "${b}"`)
  }
  // Peel threads whose blockers are all peeled; whatever never peels is on a cycle.
  const peeled = new Set<string>()
  for (let progressed = true; progressed; ) {
    progressed = false
    for (const t of threads) {
      if (!peeled.has(t.id) && t.blockedBy.every((b) => peeled.has(b))) {
        peeled.add(t.id)
        progressed = true
      }
    }
  }
  if (peeled.size !== threads.length) {
    fail(`blockedBy cycle among: ${threads.filter((t) => !peeled.has(t.id)).map((t) => t.id).join(', ')}`)
  }
  const workers = raw.workers ?? 2
  if (!Number.isInteger(workers) || workers < 1) fail('"workers" must be a positive integer')
  return { workers, threads }
}

/**
 * Merge `pilot/<id>` into the workspace checkout. A conflict is aborted and
 * recorded, never thrown: it is data about the arm, not a failed run.
 */
async function land(workspace: string, id: string, baseSha: string): Promise<Pick<ThreadRecord, 'landed' | 'commits'>> {
  const branch = `pilot/${id}`
  let commits: number
  try {
    commits = Number(await git(workspace, 'rev-list', '--count', `${baseSha}..${branch}`))
  } catch {
    return { landed: 'empty', commits: 0 } // the team never created its target branch
  }
  if (commits === 0) return { landed: 'empty', commits: 0 }
  try {
    await git(
      workspace,
      '-c', 'user.email=swarm@openswarm', '-c', 'user.name=openswarm',
      // Bookkeeping, not authorship: the repo's hooks are not ours to run (see SwarmGit.autoCommit).
      'merge', '--no-ff', '--no-verify', '-m', `pilot: land ${id}`, branch,
    )
    return { landed: 'merged', commits }
  } catch {
    await git(workspace, 'merge', '--abort').catch(() => undefined)
    return { landed: 'conflict', commits }
  }
}

export interface PilotOptions {
  plan: Plan
  arm: Arm
  workspace: string
  signal: AbortSignal
  /** Run one thread's team from `baseSha`, leaving its work on `pilot/<id>`. Throws on failure. */
  runThread: (thread: PlanThread, baseSha: string) => Promise<void>
}

export async function runPilot({ plan, arm, workspace, signal, runThread }: PilotOptions): Promise<ThreadRecord[]> {
  const records = new Map<string, ThreadRecord>(
    plan.threads.map((t) => [t.id, { id: t.id, baseSha: null, startMs: null, endMs: null, landed: 'failed', commits: 0 }]),
  )
  for (const t of plan.threads) {
    // A leftover branch from an earlier run would land that run's work as this one's.
    const stale = await git(workspace, 'rev-parse', '--verify', '--quiet', `refs/heads/pilot/${t.id}`).catch(() => '')
    if (stale !== '') throw new Error(`branch pilot/${t.id} already exists; plan mode needs a workspace without it`)
  }

  /** Run one thread; true when its team finished (its work is on `pilot/<id>`). */
  const execute = async (thread: PlanThread, baseSha: string): Promise<boolean> => {
    const record = records.get(thread.id)!
    record.baseSha = baseSha
    record.startMs = Date.now()
    try {
      await runThread(thread, baseSha)
      return true
    } catch (error) {
      record.error = message(error)
      return false
    } finally {
      record.endMs = Date.now()
    }
  }
  const landThread = async (id: string): Promise<void> => {
    const record = records.get(id)!
    Object.assign(record, await land(workspace, id, record.baseSha!))
  }

  if (arm === 'sharded') {
    const base = await git(workspace, 'rev-parse', 'HEAD')
    const finished = await Promise.all(plan.threads.map((t) => execute(t, base)))
    for (const [i, t] of plan.threads.entries()) if (finished[i]) await landThread(t.id)
  } else {
    // `empty` counts as landed: there was nothing to land, so nothing is missing.
    const landed = new Set<string>()
    const running = new Map<string, Promise<[string, boolean]>>()
    const settled = new Set<string>()
    const launchReady = async (): Promise<void> => {
      if (signal.aborted) return
      const head = await git(workspace, 'rev-parse', 'HEAD')
      for (const t of plan.threads) {
        if (running.has(t.id) || settled.has(t.id) || !t.blockedBy.every((b) => landed.has(b))) continue
        running.set(t.id, execute(t, head).then((ok): [string, boolean] => [t.id, ok]))
      }
    }
    // One loop lands and launches, so landings are serialized and every cut
    // reads a HEAD no landing is halfway through.
    await launchReady()
    while (running.size > 0) {
      const [id, ok] = await Promise.race(running.values())
      running.delete(id)
      settled.add(id)
      if (ok) {
        await landThread(id)
        const outcome = records.get(id)!.landed
        if (outcome === 'merged' || outcome === 'empty') landed.add(id)
      }
      await launchReady()
    }
  }

  for (const t of plan.threads) {
    const record = records.get(t.id)!
    if (record.startMs !== null) continue
    const missing = t.blockedBy.filter((b) => records.get(b)!.landed !== 'merged' && records.get(b)!.landed !== 'empty')
    record.error = signal.aborted ? 'not started: run aborted' : `not started: blockedBy ${missing.join(', ')} did not land`
  }
  return [...records.values()]
}
