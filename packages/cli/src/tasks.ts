/**
 * `openswarm tasks sync` (docs/05 B0, projection first): mirror a run's board
 * into an opentasks graph so other tools see its tasks, owners, statuses and
 * gate evidence. One-way: the run journal stays authoritative, and nothing
 * here claims, completes or reads task state from opentasks to drive a run.
 *
 * `opentasks/client` is imported only when a sync connects, so a user without
 * opentasks installed pays nothing. Which graph node mirrors which journal
 * item is kept in `<runDir>/opentasks.json`, written atomically after every
 * write, so a re-sync creates only what is missing and transitions only what
 * changed; a lost or corrupt map re-adopts the run's nodes and edges from the
 * graph instead of duplicating them. One syncer per run holds
 * `<runDir>/opentasks.lock`. Each write is best-effort: one that fails is
 * reported and retried by the next sync, never fatal to the run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { OpenTasksClient } from 'opentasks/client'
import {
  SwarmJournal,
  defaultRunsDir,
  foldBoard,
  foldRun,
  gateLine,
  pidAlive,
  renderIntent,
  runJournalPath,
  writerLive,
  type SwarmGateEvent,
  type SwarmRunRecord,
  type SwarmTaskSnapshot,
} from 'openswarm-swarm'
import type { CliIo } from './index'

/** The client calls a sync makes. */
export type SyncClient = Pick<OpenTasksClient, 'createNode' | 'getNode' | 'updateNode' | 'link' | 'task' | 'query' | 'call'>

/** A board status, plus `abandoned`: not completed when its run settled, so nothing will run it. */
type Mirrored = SwarmTaskSnapshot['status'] | 'abandoned'

/** `<runDir>/opentasks.json`: journal items → graph ids. Delete it to project the run afresh. */
export interface SyncMapping {
  version: 1
  /** The last journal seq whose effects all reached the graph; a sync with nothing newer does nothing. */
  seq: number
  /** The run's context node. */
  run?: string
  /** Verifier context nodes, by verifier (`openswarm-gate:commands`, `human:<by>`). */
  verifiers: Record<string, string>
  /** Task nodes by board task id, with the status and owner last mirrored. */
  tasks: Record<string, { node: string; status?: Mirrored; owner?: string }>
  /** Attempt nodes by the journal seq of their `swarm/gate` event. */
  attempts: Record<string, string>
  /** Edge ids by key: `implements:<task>`, `blocks:<blocker>><task>`, `verifies:<seq>`, `verifies:human:<task>`. */
  edges: Record<string, string>
}

export interface SyncResult {
  /** Created by this sync, or found already in the graph and adopted (a lost map). */
  nodes: { created: number; adopted: number }
  edges: { created: number; adopted: number }
  /** Status transitions applied by this sync. */
  transitions: number
  /** Writes that failed; the next sync retries them. */
  errors: { item: string; error: string }[]
  /** The run is no longer running, so nothing more will be journaled. */
  settled: boolean
  /** The run record the sync read. */
  run: SwarmRunRecord
}

/** opentasks status for each mirrored board status (native task lifecycle). */
const TARGET: Record<Mirrored, string> = { pending: 'open', in_progress: 'in_progress', completed: 'closed', abandoned: 'abandoned' }

type TaskAction = 'start' | 'complete' | 'block' | 'reopen' | 'abandon'

/**
 * Transitions valid in opentasks' native lifecycle from `from` to `to`
 * (open → start | abandon; in_progress → complete | block | abandon;
 * blocked and the terminal states → reopen).
 */
function actions(from: string, to: string): TaskAction[] {
  if (from === to) return []
  if (from === 'open') return to === 'in_progress' ? ['start'] : to === 'closed' ? ['start', 'complete'] : ['abandon']
  if (from === 'in_progress') {
    return to === 'closed' ? ['complete'] : to === 'abandoned' ? ['abandon'] : ['block', 'reopen', ...actions('open', to)]
  }
  return ['reopen', ...actions('open', to)]
}

/** The run's intent header and its task list, as the run context's content. */
function runContent(run: SwarmRunRecord): string {
  const spec = run.spec
  const tasks =
    spec?.topology === 'peer-team' ? spec.tasks.map((t) => `- ${t.subject}`) : spec !== undefined && 'task' in spec ? [spec.task] : []
  return [
    ...(spec?.intent === undefined ? [] : [renderIntent(spec.intent)]),
    ...(tasks.length === 0 ? [] : [`## Tasks\n${tasks.join('\n')}`]),
  ].join('\n\n')
}

/**
 * Make the opentasks graph match one run's journal: a context node for the
 * run, a task node per board task (implementing the run, blocked by its
 * blockers, status and assignee mirrored), an attempt per gate round and a
 * `verifies` edge per verdict (docs/ATTEMPT-VERIFY-SCHEMA in opentasks).
 * `target` is the run's directory or its journal file. The caller holds the
 * run's lock ({@link lockRun}); throws, before writing anything, when the
 * map names nodes this graph does not hold.
 */
export async function syncRun(target: string, { client }: { client: SyncClient }): Promise<SyncResult> {
  const journalPath = target.endsWith('.jsonl') ? target : join(target, 'journal.jsonl')
  const mapPath = join(dirname(journalPath), 'opentasks.json')
  const events = SwarmJournal.read(journalPath)
  const run = foldRun(events)
  if (run === undefined) throw new Error(`no run record in ${journalPath}`)
  const empty: SyncMapping = { version: 1, seq: -1, verifiers: {}, tasks: {}, attempts: {}, edges: {} }
  let loaded: SyncMapping | undefined
  try {
    const parsed = JSON.parse(readFileSync(mapPath, 'utf8'))
    if (parsed?.version === 1) loaded = { ...empty, ...parsed }
  } catch {
    // Missing or corrupt: re-adopt from the graph below.
  }
  const map = loaded ?? empty
  const result: SyncResult = {
    nodes: { created: 0, adopted: 0 },
    edges: { created: 0, adopted: 0 },
    transitions: 0,
    errors: [],
    settled: run.status !== 'running',
    run,
  }
  if (map.run !== undefined) {
    const node = (await client.getNode(map.run)) as { metadata?: { openswarm?: { runId?: string } } } | null
    if (node?.metadata?.openswarm?.runId !== run.id) {
      throw new Error(`run ${run.id} was synced to a different graph (${map.run} is not its node here); remove ${mapPath} to re-project it`)
    }
  }
  const last = events.at(-1)?.seq ?? -1
  if (map.seq === last) return result

  const tags = ['openswarm', `run:${run.id}`]
  const board = foldBoard(events)
  const gates = events.filter((e) => e.type === 'swarm/gate')
  const completedAt = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'swarm/task' && (e.data as { task: SwarmTaskSnapshot }).task.status === 'completed') {
      completedAt.set((e.data as { task: SwarmTaskSnapshot }).task.id, e.time)
    }
  }
  const spec = run.spec?.topology === 'peer-team' ? run.spec : undefined

  let saved = loaded === undefined ? '' : JSON.stringify(map)
  /** Write the map when it changed, atomically: a crash leaves the old map or the new, never half of one. */
  const save = () => {
    const text = JSON.stringify(map)
    if (text === saved) return
    const tmp = `${mapPath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(map, null, 1)}\n`)
    renameSync(tmp, mapPath)
    saved = text
  }
  /** Run one write, then persist what it mapped; a failure is reported, and the sync goes on. */
  const step = async (item: string, write: () => Promise<unknown>): Promise<void> => {
    try {
      await write()
      save()
    } catch (error) {
      result.errors.push({ item, error: error instanceof Error ? error.message : String(error) })
    }
  }
  /**
   * The run's nodes already in the graph, by `metadata.openswarm.key`; read
   * only when the map was lost. graph.query takes an explicit limit, where the
   * `query` tool stops at 100 rows before its tag filter.
   */
  let adoptable: Promise<Map<string, string>> | undefined
  const existing = async (key: string): Promise<string | undefined> => {
    if (loaded !== undefined) return undefined
    adoptable ??= client
      .call<{ id: string; metadata?: { openswarm?: { runId?: string; key?: string } } }[]>('graph.query', {
        filter: { tags: [`run:${run.id}`] },
        limit: 1_000_000,
      })
      .then((nodes) => new Map(nodes.flatMap((n) => (n.metadata?.openswarm?.runId === run.id && n.metadata.openswarm.key ? [[n.metadata.openswarm.key, n.id]] : []))))
    return (await adoptable).get(key)
  }
  /**
   * Adopt the node already holding `key`, else create it. The idempotency key
   * also dedupes a retry whose map write was lost (within the daemon's window).
   */
  const create = async (key: string, input: Parameters<SyncClient['createNode']>[0]): Promise<string> => {
    const found = await existing(key)
    if (found !== undefined) {
      result.nodes.adopted++
      return found
    }
    const node = (await client.createNode(
      { ...input, metadata: { ...input.metadata, openswarm: { ...(input.metadata?.['openswarm'] as object), runId: run.id, key } } },
      { idempotencyKey: `openswarm:${run.id}:${key}` },
    )) as { id: string }
    result.nodes.created++
    return node.id
  }
  /** Map the `(from, to, type)` edge, reusing one already in the graph. */
  const link = async (key: string, fromId: string | undefined, toId: string | undefined, type: 'implements' | 'blocks' | 'verifies', metadata?: Record<string, unknown>) => {
    if (map.edges[key] !== undefined) return
    if (fromId === undefined || toId === undefined) throw new Error('an endpoint has not synced')
    const from = (await client.query({ edges: { from_id: fromId, type }, verbose: true, limit: 1_000_000 })).items as unknown as { id: string; to_id: string }[]
    const found = from.find((e) => e.to_id === toId)
    if (found !== undefined) {
      map.edges[key] = found.id
      result.edges.adopted++
      return
    }
    const linked = await client.link({ fromId, toId, type, ...(metadata === undefined ? {} : { metadata }) })
    if (!linked.success || linked.edgeId === undefined) throw new Error(linked.error ?? 'link failed')
    map.edges[key] = linked.edgeId
    result.edges.created++
  }
  const verifier = async (name: string): Promise<string> =>
    (map.verifiers[name] ??= await create(`verifier:${name}`, {
      type: 'context',
      title: `${name} (${run.id})`,
      tags,
      metadata: { openswarm: { verifier: name } },
    }))

  try {
    await step(`run ${run.id}`, async () => {
      const content = runContent(run)
      map.run ??= await create('run', {
        type: 'context',
        title: `openswarm ${run.topology} ${run.id}`,
        ...(content === '' ? {} : { content }),
        tags,
        metadata: { openswarm: { topology: run.topology } },
      })
    })

    // Every task node first: a fold is ordered by last change, so a blocker may come after its dependent.
    for (const t of board.values()) {
      const checks = t.checks ?? spec?.gate?.checks
      await step(t.id, async () => {
        map.tasks[t.id] ??= {
          node: await create(t.id, {
            type: 'task',
            title: t.subject,
            content: t.prompt,
            status: 'open',
            tags,
            metadata: { openswarm: { taskId: t.id, ...(checks === undefined ? {} : { checks }) } },
          }),
        }
      })
    }
    for (const t of board.values()) {
      await step(`${t.id} implements`, () => link(`implements:${t.id}`, map.tasks[t.id]?.node, map.run, 'implements'))
      for (const b of t.blockedBy) {
        await step(`${t.id} blocked by ${b}`, () => link(`blocks:${b}>${t.id}`, map.tasks[b]?.node, map.tasks[t.id]?.node, 'blocks'))
      }
    }

    // One attempt per gate round, and a `verifies` edge for each round that reached a verdict.
    for (const e of gates) {
      const g = e.data as SwarmGateEvent
      const line = gateLine(g)
      const checks = board.get(g.taskId)?.checks ?? spec?.gate?.checks ?? []
      // A hidden suite is referred to by name only: its content never leaves the verifier.
      const evidence = {
        kind: g.kind === 'commands' ? 'command' : g.kind === 'hidden' ? 'test' : 'commit',
        ref:
          g.kind === 'commands' && checks.length > 0
            ? checks.join('\n')
            : g.kind === 'hidden' && g.suite !== undefined
              ? `hidden suite ${g.suite}`
              : (g.snapshot ?? `${g.taskId} round ${g.round}`),
        detail: line,
        ...(g.snapshot === undefined ? {} : { hash: g.snapshot }),
      }
      await step(`${g.taskId} gate round ${g.round} (#${e.seq})`, async () => {
        const task = map.tasks[g.taskId]?.node
        if (task === undefined) throw new Error('its task has not synced')
        map.attempts[e.seq] ??= await create(`gate:${e.seq}`, {
          type: 'attempt',
          title: `${board.get(g.taskId)?.subject ?? g.taskId}: gate round ${g.round} (${g.member})`,
          target_id: task,
          assignee: g.member,
          status: 'closed',
          tags,
          metadata: {
            attempt: { outcome: g.passed ? 'success' : 'failure', summary: line, evidence, ...(g.passed ? {} : { failureReason: line }) },
            openswarm: { taskId: g.taskId, round: g.round, seq: e.seq },
          },
        })
      })
      // A review or suite that could not run, or a round that changed nothing, was not checked: no verdict.
      // A tamper round was: it fails.
      if (g.error !== undefined || (g.round > 1 && !g.changed && g.tamper !== true)) continue
      const name = `openswarm-gate:${g.kind}`
      await step(`${g.taskId} gate round ${g.round} verdict (#${e.seq})`, async () =>
        link(`verifies:${e.seq}`, await verifier(name), map.attempts[e.seq], 'verifies', {
          verdict: g.passed ? 'pass' : 'fail',
          verifier: name,
          // The verifier level (docs/05 §6.4): what the verdict is worth; a
          // partly confined L3 run says so, and a board counts it as L2.
          level: g.level ?? 0,
          ...(g.enforcement === undefined ? {} : { enforcement: g.enforcement }),
          evidence,
          verifiedAt: new Date(e.time).toISOString(),
        }),
      )
    }

    for (const t of board.values()) {
      // A human waiver (P8) verifies the task's last attempt, or the task itself if it had none.
      if (t.status === 'completed' && t.evidence?.kind === 'human') {
        const name = `human:${t.evidence.by}`
        const lastRound = gates.filter((e) => (e.data as SwarmGateEvent).taskId === t.id).at(-1)
        await step(`${t.id} waiver`, async () =>
          link(
            `verifies:human:${t.id}`,
            await verifier(name),
            lastRound === undefined ? map.tasks[t.id]?.node : map.attempts[lastRound.seq],
            'verifies',
            {
              verdict: 'pass',
              verifier: name,
              evidence: { kind: 'external', ref: name, detail: 'accepted without passing evidence' },
              verifiedAt: new Date(completedAt.get(t.id) ?? Date.now()).toISOString(),
            },
          ),
        )
      }

      const mirrored = map.tasks[t.id]
      if (mirrored === undefined) continue
      const status: Mirrored =
        t.status !== 'completed' && (run.status === 'finished' || run.status === 'failed') ? 'abandoned' : t.status
      if (mirrored.status === status && mirrored.owner === t.owner) continue
      await step(`${t.id} ${status}`, async () => {
        const node = (await client.getNode(mirrored.node)) as { status?: string; assignee?: string } | null
        if (node === null) throw new Error(`node ${mirrored.node} is gone from the graph`)
        if (node.assignee !== t.owner) await client.updateNode(mirrored.node, { assignee: (t.owner ?? null) as string })
        for (const action of actions(node.status ?? 'open', TARGET[status])) {
          const moved = await client.task({ transition: { id: mirrored.node, action } })
          if (!moved.success) throw new Error(moved.error ?? `${action} failed`)
          result.transitions++
        }
        map.tasks[t.id] = { node: mirrored.node, status, ...(t.owner === undefined ? {} : { owner: t.owner }) }
      })
    }
    if (result.errors.length === 0) map.seq = last
  } finally {
    save()
  }
  return result
}

/**
 * Take `<runDir>/opentasks.lock` for one syncer, returning its release. A
 * lock whose pid is gone (a syncer killed mid-watch) is taken over.
 */
export function lockRun(runDir: string): () => void {
  const path = join(runDir, 'opentasks.lock')
  const take = () => writeFileSync(path, `${process.pid}\n`, { flag: 'wx' })
  try {
    take()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let holder = NaN
    try {
      holder = Number(readFileSync(path, 'utf8').trim())
    } catch {
      // Released meanwhile: another syncer is starting, so refuse below.
    }
    // ponytail: same-host pid liveness, like writerLive; a runs dir shared across hosts needs a real lease.
    if (!Number.isInteger(holder) || holder <= 0 || pidAlive(holder)) {
      throw new Error(`another \`openswarm tasks sync\` (pid ${holder || '?'}) is syncing this run; one syncer per run (${path})`)
    }
    rmSync(path, { force: true })
    take()
  }
  return () => rmSync(path, { force: true })
}

const START_DAEMON =
  'start one with `npx opentasks daemon start` (set OPENTASKS_PROJECT_DIR to a directory outside your repository: ' +
  'opentasks rewrites its graph.jsonl continuously), then pass its socket with --socket or OPENTASKS_SOCKET'

async function loadClient(): Promise<typeof import('opentasks/client')> {
  try {
    return await import('opentasks/client')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error
    throw new Error('`openswarm tasks` needs opentasks; install it with `npm install opentasks@0.2.0`')
  }
}

/** The daemon socket: `explicit`, else the opentasks client's own discovery. Never starts a daemon. */
export async function resolveSocket(explicit?: string): Promise<string> {
  if (explicit !== undefined) return resolve(explicit)
  const { getDefaultSocketPath } = await loadClient()
  // ponytail: discovery's last step initializes the global store; aim it at a scratch dir when that store
  // does not exist yet, so finding no daemon leaves no ~/.opentasks behind. Upstream: a side-effect-free lookup.
  const home = process.env['OPENTASKS_HOME']
  const scratch = existsSync(home ?? join(homedir(), '.opentasks')) ? undefined : mkdtempSync(join(tmpdir(), 'openswarm-opentasks-'))
  if (scratch !== undefined) process.env['OPENTASKS_HOME'] = scratch
  try {
    return getDefaultSocketPath()
  } catch {
    throw new Error(`no opentasks daemon found\n${START_DAEMON}`)
  } finally {
    if (scratch !== undefined) {
      if (home === undefined) delete process.env['OPENTASKS_HOME']
      else process.env['OPENTASKS_HOME'] = home
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

/** A client connected at `socketPath`. */
export async function connectOpenTasks(socketPath: string): Promise<OpenTasksClient> {
  const client = (await loadClient()).createClient({ socketPath })
  try {
    await client.connect()
  } catch (error) {
    throw new Error(`no opentasks daemon reachable at ${socketPath}: ${error instanceof Error ? error.message : String(error)}\n${START_DAEMON}`)
  }
  return client
}

/** The git repository (work tree or common dir) of `cwd` that holds `path`, if any. */
export function repoHolding(path: string, cwd = process.cwd()): string | undefined {
  let dirs: string[]
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    dirs = out.trim().split('\n').map((dir) => realpathSync(resolve(cwd, dir)))
  } catch {
    return undefined
  }
  const target = real(resolve(path))
  return dirs.some((dir) => target === dir || target.startsWith(dir + sep)) ? dirs[0] : undefined
}

/** `path` with its nearest existing ancestor's symlinks resolved (macOS's /var is /private/var). */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(real(parent), basename(path))
  }
}

/**
 * `openswarm tasks sync <run> [--watch] [--socket <path>]`: one sync, or
 * (`--watch`) one per second the journal grows, until the run settles or its
 * writer dies.
 */
export async function tasksSync(runId: string, options: { socket?: string; watch: boolean }, io: CliIo): Promise<number> {
  const journalPath = runJournalPath(defaultRunsDir(), runId)
  if (!existsSync(journalPath)) throw new Error(`unknown run "${runId}"`)
  const release = lockRun(dirname(journalPath))
  try {
    const socket = await resolveSocket(options.socket ?? process.env['OPENTASKS_SOCKET'])
    const repo = repoHolding(socket)
    if (repo !== undefined) {
      io.err(
        `warning: the opentasks graph at ${socket} is inside the git repository ${repo}: it will receive this run's prompts and checks. ` +
          'Point OPENTASKS_PROJECT_DIR (or --socket) at a daemon outside the repository.',
      )
    }
    const client = await connectOpenTasks(socket)
    try {
      let shown = ''
      for (let first = true; ; first = false) {
        const r = await syncRun(journalPath, { client })
        const wrote = r.nodes.created + r.nodes.adopted + r.edges.created + r.edges.adopted + r.transitions > 0
        if (first || wrote || !options.watch || r.settled) {
          io.out(
            `${runId} → ${socket}: ${r.nodes.created} node(s) created, ${r.nodes.adopted} adopted; ` +
              `${r.edges.created} edge(s) created, ${r.edges.adopted} adopted; ${r.transitions} transition(s)`,
          )
        }
        // A write that keeps failing is retried every sync; say so once, not every second.
        const errors = r.errors.map((e) => `${e.item}: ${e.error}`).join('\n')
        if (errors !== shown && errors !== '') io.err(errors)
        shown = errors
        if (!options.watch || r.settled) return errors === '' ? 0 : 1
        if (!writerLive(r.run)) {
          io.err(`${runId}'s writer pid ${r.run.writer.pid} is gone, so nothing more will be journaled; stopping (\`openswarm attach ${runId}\` takes the run over)`)
          return 1
        }
        // ponytail: polls like `attach`; the lead's waitForAppend wakes only in-process.
        await sleep(1_000)
      }
    } finally {
      client.disconnect()
    }
  } finally {
    release()
  }
}
