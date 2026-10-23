/**
 * What the CLI member runtimes share (docs/05 §5.4: `claude-code`, R1;
 * `codex`, R2): one headless agent CLI run as a child process in the
 * member's cwd, its prompt on stdin, its JSONL stdout read line by line,
 * stopped on a cancel, a timeout, or when it lingers after its final event.
 *
 * A stop sends `interrupt` (SIGTERM for Claude Code; SIGINT for Codex, which
 * handles no SIGTERM), then SIGKILL after a grace, to the CLI's process group
 * and to every descendant a `ps` walk finds from its pid at that moment: both
 * CLIs start their shell tools in sessions of their own, outside the group.
 * ponytail: one walk at the stop; what they spawn after it, or detach from
 * them, outlives the member until the CLI's own shutdown reaps it.
 */
import { execFileSync, spawn } from 'node:child_process'

/** Credential-shaped names, as dsh's spawner scrubs them (`@deepseek-ai/dsh-subprocess`'s `SENSITIVE_ENV_PATTERN`). */
const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i
/** The launcher's own routes: OpenSwarm's, dsh's, and the providers its dsh members speak. */
const ROUTES = /^(OPENSWARM_|DSH_|DEEPSEEK_|OPENAI_|AZURE_API_)/i

/** How long a stopped CLI's processes have between the interrupt and SIGKILL. */
const KILL_GRACE_MS = 5_000
/** How long a CLI has to exit once it has sent its final event. */
const EXIT_GRACE_MS = 10_000

/**
 * The parent's environment without its credentials and the launcher's
 * routes, keeping the names `kept` says the CLI reads for its own login.
 */
export function cliEnv(kept: (name: string) => boolean, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && (kept(entry[0]) || !(SENSITIVE.test(entry[0]) || ROUTES.test(entry[0])))),
  )
}

/** Every process descending from `pid` now, by walking `ps`'s parent links. */
function descendants(pid: number): number[] {
  let table: string
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child !== undefined && parent !== undefined && !Number.isNaN(parent)) children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found: number[] = []
  for (const queue = [pid]; queue.length > 0; ) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

export interface CliRun {
  /** How the process ended: `code N`, a signal name, or why it could not start. */
  exit: string
  stderr: string
  spawnError?: Error
  aborted: boolean
  timedOut: boolean
}

/**
 * Run one CLI to its end. `onLine` gets each stdout line (the last one too,
 * without its newline), `done`, which it calls once a final event is in (a
 * CLI that prints nothing more for `exitGraceMs`, or the grace `done` is
 * given, is stopped), and `busy`, which disarms that until the next `done`
 * (the CLI is working again). Resolves once the process has closed, however
 * it ended; never rejects.
 */
export async function runCli(options: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Written to stdin, which is then closed, unless `hold`. */
  input: string
  /**
   * Keep stdin open after `input`: `onInput` gets a writer for more of it and
   * the means to close it, which the caller must, as the CLI runs until then.
   */
  hold?: { onInput: (input: { write: (text: string) => boolean; end: () => void }) => void }
  interrupt: NodeJS.Signals
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  exitGraceMs?: number | undefined
  onLine: (line: string, done: (graceMs?: number) => void, busy: () => void) => void
}): Promise<CliRun> {
  const run: CliRun = { exit: '', stderr: '', aborted: false, timedOut: false }
  let lingering: ReturnType<typeof setTimeout> | undefined
  // Its own process group, so a stop reaches what it starts there. The prompt
  // goes on stdin: no ARG_MAX, and a prompt starting with `-` is not a flag.
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const group = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  let stopping = false
  const stop = () => {
    if (stopping || child.pid === undefined) return
    stopping = true
    const tree = descendants(child.pid)
    const signal = (sig: NodeJS.Signals) => {
      group(sig)
      for (const pid of tree) {
        try {
          process.kill(pid, sig)
        } catch {}
      }
    }
    signal(options.interrupt)
    // Never cleared: a tool process outside its group may outlast the CLI.
    setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref()
  }
  const cancel = () => {
    run.aborted = true
    stop()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  const bounded = options.timeoutMs === undefined ? undefined : setTimeout(() => ((run.timedOut = true), stop()), options.timeoutMs)
  const done = (graceMs = options.exitGraceMs ?? EXIT_GRACE_MS) => {
    clearTimeout(lingering)
    lingering = setTimeout(stop, graceMs)
  }
  const busy = () => {
    clearTimeout(lingering)
    lingering = undefined
  }

  let pending = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()!
    for (const line of lines) options.onLine(line, done, busy)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (run.stderr = (run.stderr + chunk).slice(-4_000)))
  // A CLI that exits before reading its prompt closes the pipe under us.
  child.stdin.on('error', () => undefined)
  if (options.hold === undefined) child.stdin.end(options.input)
  else {
    child.stdin.write(options.input)
    options.hold.onInput({
      // Queued is written: write's false only asks for backpressure, and a
      // caller treating it as refused would deliver the text a second way.
      write: (text) => child.stdin.writable && (child.stdin.write(text), true),
      end: () => void (child.stdin.writable && child.stdin.end()),
    })
  }
  run.exit = await new Promise<string>((resolve) => {
    child.once('error', (error) => {
      run.spawnError = error
      resolve(error.message)
    })
    // Reap what it left running in its group, so its pipes close and `close` comes.
    child.once('exit', () => group('SIGKILL'))
    child.once('close', (code, signal) => resolve(signal ?? `code ${code}`))
  })
  if (pending !== '') options.onLine(pending, done, busy)
  clearTimeout(bounded)
  clearTimeout(lingering)
  options.signal?.removeEventListener('abort', cancel)
  return run
}
