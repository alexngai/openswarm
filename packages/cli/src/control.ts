/**
 * The control verbs (docs/05 §6.1, A8). `ps`, `board`, `questions` and
 * `attach` read run journals under `$OPENSWARM_HOME/runs` directly, so they
 * need no server and see a run whose process died; `attach` takes such a run
 * over. `start`, `steer`, `answer` and `kill` direct a running
 * `openswarm serve` over its socket carrier, as the owner whose token it
 * wrote to `$OPENSWARM_HOME/app-server.json`.
 */
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import {
  SwarmJournal,
  attachRun,
  coordinatorSpec,
  defaultRunsDir,
  foldRun,
  listRuns,
  openswarmHome,
  pidAlive,
  recapJournal,
  resultText,
  runJournalPath,
  viewRun,
  writerLive,
  type SwarmRunView,
  type TeamSpec,
} from 'openswarm-swarm'
import type { CliIo } from './index'

const USAGE = `usage: openswarm ps [--json]
       openswarm board <run> [--json]
       openswarm questions [--run <id>] [--json]
       openswarm attach <run> [--no-follow]
       openswarm start <"task" | spec.json> [--workers N] [--provider P] [--model M] [--question-timeout MS]
       openswarm steer <run> --to <member> "text"
       openswarm answer <run> <question> <choice>
       openswarm kill <run>`

const VALUE_FLAGS = new Set(['--run', '--to', '--workers', '--provider', '--model', '--question-timeout'])
const BOOL_FLAGS = new Set(['--json', '--no-follow'])

/** Run one control verb; resolves to the exit code (2 for a usage error). */
export async function runControl(
  argv: string[],
  io: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) },
): Promise<number> {
  const flags = new Map<string, string>()
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (VALUE_FLAGS.has(a) && argv[i + 1] !== undefined) flags.set(a, argv[++i]!)
    else if (BOOL_FLAGS.has(a)) flags.set(a, '')
    else if (a.startsWith('--')) return usage(io, `unknown option, or one missing its value: ${a}`)
    else args.push(a)
  }
  const [verb, run, ...rest] = args
  const dir = defaultRunsDir()
  const json = (value: unknown) => {
    io.out(JSON.stringify(value))
    return 0
  }
  try {
    switch (verb) {
      case 'ps': {
        const runs = listRuns(dir)
        if (flags.has('--json')) return json(runs.map(({ spec: _spec, result: _result, ...record }) => record))
        if (runs.length === 0) io.out('no runs')
        else {
          table(io, [
            ['RUN', 'STATUS', 'TOPOLOGY', 'AGE', 'WRITER'],
            ...runs.map((r) => [
              r.id,
              r.status,
              r.topology,
              age(r.startedAt),
              `pid ${r.writer.pid}${r.status === 'running' && !writerLive(r) ? ' (dead)' : ''}`,
            ]),
          ])
        }
        return 0
      }
      case 'board': {
        if (run === undefined) break
        const view = viewRun(dir, run)
        if (flags.has('--json')) {
          return json({ run: view.run.id, status: view.run.status, tasks: view.tasks, openQuestions: openCount(view) })
        }
        board(io, view)
        return 0
      }
      case 'questions': {
        const runIds = flags.has('--run')
          ? [flags.get('--run')!]
          : listRuns(dir).flatMap((r) => (r.status === 'running' ? [r.id] : []))
        const open = runIds.flatMap((id) =>
          viewRun(dir, id).questions.flatMap((q) => (q.status === 'open' ? [{ runId: id, ...q }] : [])),
        )
        if (flags.has('--json')) return json(open)
        if (open.length === 0) io.out('no open questions')
        for (const q of open) {
          io.out(`${q.runId} ${q.id} (${q.trigger}): ${q.prompt}`)
          io.out(`  answer with one of: ${q.options.join(', ')} (default ${q.default})`)
        }
        return 0
      }
      case 'attach': {
        if (run === undefined) break
        const view = viewRun(dir, run)
        if (view.run.status === 'running' && !writerLive(view.run)) {
          const { released, ...attached } = await attachRun(dir, run)
          board(io, attached)
          const ids = released.map((task) => task.id).join(', ')
          io.out(`released ${released.length} claim(s) of dead writer pid ${view.run.writer.pid}${ids === '' ? '' : `: ${ids}`}`)
          for (const line of attached.recap) io.out(line)
          return 0
        }
        board(io, view)
        // The recap, then (a live writer's run) each new line as it is journaled, until the run settles.
        const path = runJournalPath(dir, run)
        let since = -1
        while (true) {
          const events = SwarmJournal.read(path)
          for (const line of recapJournal(events, since)) io.out(line)
          since = events.at(-1)?.seq ?? since
          const record = foldRun(events)!
          if (record.status !== 'running' || flags.has('--no-follow')) return 0
          if (!writerLive(record)) {
            io.err(`writer pid ${record.writer.pid} died; \`openswarm attach ${run}\` again takes the run over`)
            return 1
          }
          await sleep(1_000)
        }
      }
      case 'start': {
        const target = args.slice(1).join(' ')
        if (target === '') break
        const workers = Number(flags.get('--workers') ?? 3)
        if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers takes a positive integer')
        // A lone word ending in .json is a spec file; anything else is the task, as `/swarm` takes it.
        const spec: TeamSpec = /^\S+\.json$/.test(target)
          ? JSON.parse(readFileSync(target, 'utf8'))
          : coordinatorSpec(target, workers)
        const timeout = flags.get('--question-timeout')
        const { runId } = await call('swarm/start', {
          spec,
          ...(flags.has('--provider') ? { provider: flags.get('--provider') } : {}),
          ...(flags.has('--model') ? { model: flags.get('--model') } : {}),
          ...(timeout === undefined ? {} : { questionTimeoutMs: Number(timeout) }),
        })
        io.out(runId)
        return 0
      }
      case 'steer': {
        const text = rest.join(' ')
        if (run === undefined || !flags.has('--to') || text === '') break
        const { delivery } = await call('swarm/steer', { runId: run, to: flags.get('--to'), text })
        io.out(delivery)
        return 0
      }
      case 'answer': {
        const [questionId, answer] = rest
        if (run === undefined || questionId === undefined || answer === undefined || rest.length > 2) break
        await call('swarm/answer', { runId: run, questionId, answer })
        io.out(`answered ${questionId}: ${answer}`)
        return 0
      }
      case 'kill': {
        if (run === undefined) break
        await call('swarm/cancel', { runId: run })
        io.out(`cancelled ${run}`)
        return 0
      }
    }
  } catch (error) {
    // Protocol errors lead with their code (FORBIDDEN, NOT_FOUND, …); shown verbatim.
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
  return usage(io)
}

function usage(io: CliIo, problem?: string): number {
  io.err(problem === undefined ? USAGE : `${problem}\n${USAGE}`)
  return 2
}

/** One `swarm/*` call to the running app-server, authenticated as its owner. */
async function call(method: string, params: object): Promise<any> {
  const file = join(openswarmHome(), 'app-server.json')
  const server = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string; pid: number })
    : undefined
  if (server === undefined || !pidAlive(server.pid)) throw new Error('no app-server running; start one with `openswarm serve`')
  const colon = server.url.lastIndexOf(':')
  const socket = connect({ host: server.url.slice(0, colon), port: Number(server.url.slice(colon + 1)) })
  try {
    await once(socket, 'connect')
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.start()
    await transport.request('swarm/auth', { token: server.token })
    return await transport.request(method, params)
  } finally {
    socket.destroy()
  }
}

const openCount = (view: SwarmRunView) => view.questions.filter((q) => q.status === 'open').length

/**
 * The run's line and intent, its tasks in id order (with any end state of
 * their own), how many questions are open, and a finished run's result.
 */
function board(io: CliIo, view: SwarmRunView): void {
  io.out(`${view.run.id}  ${view.run.status}  ${view.run.topology}`)
  const intent = view.run.spec?.intent
  if (intent !== undefined) io.out(`purpose: ${intent.purpose}\nend state: ${intent.endState}`)
  const tasks = [...view.tasks].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
  if (tasks.length === 0) io.out('no board tasks')
  else table(io, [['TASK', 'STATUS', 'OWNER', 'SUBJECT'], ...tasks.map((t) => [t.id, t.status, t.owner ?? '-', t.subject])])
  for (const t of tasks) {
    if (t.intent !== undefined && t.intent.endState !== intent?.endState) io.out(`${t.id} end state: ${t.intent.endState}`)
  }
  io.out(`${openCount(view)} open question(s)`)
  if (view.run.status === 'finished' && view.run.result !== undefined) io.out(`result:\n${resultText(view.run.result)}`)
}

/** Rows as left-aligned columns. */
function table(io: CliIo, rows: string[][]): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  for (const row of rows) io.out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd())
}

/** Time since `time`, coarsely: `42s`, `5m`, `3h`, `2d`. */
function age(time: number): string {
  const s = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3_600) return `${Math.floor(s / 60)}m`
  return s < 86_400 ? `${Math.floor(s / 3_600)}h` : `${Math.floor(s / 86_400)}d`
}
