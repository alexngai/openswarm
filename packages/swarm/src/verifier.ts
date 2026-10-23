/**
 * The L3 verifier, gate side (docs/05 B1, D4): run a hidden suite on a round's
 * snapshot through the verifier's helper, and scan the round for a member
 * reaching for the suite (a tamper incident, §6.4).
 *
 * The helper (`../verifier-helper.mjs`, installed by `openswarm verifier
 * setup`) runs as a separate OS user that alone can read the store, so the
 * kernel denies members, who run as the operator, any read of it. This side
 * only ever sees the helper's summaries. None of it means anything when
 * members run as root, who can read any file, so it refuses to start then;
 * nor on a host that cannot confine a suite's run, unless the operator says
 * `OPENSWARM_VERIFIER_ALLOW_PARTIAL=1` (and such a run counts as L2 on a board).
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { HiddenSuite, HiddenSummary, TamperSignal } from './gate'
import type { MemberRunResult } from './types'

const execFileAsync = promisify(execFile)

const libexec = '/usr/local/libexec/openswarm-verifier'

/**
 * Where `openswarm verifier setup` installs on `platform`: a hidden system
 * user (macOS keeps those `_`-prefixed and under uid 500), its 0700 store, a
 * root-owned helper, and the sudoers rules that let the operator run it.
 */
export function verifierInstall(platform: NodeJS.Platform = process.platform) {
  return {
    user: platform === 'darwin' ? '_openswarmverifier' : 'openswarm-verifier',
    store: platform === 'darwin' ? '/Library/Application Support/openswarm-verifier' : '/var/lib/openswarm-verifier',
    libexec,
    helper: join(libexec, 'openswarm-verifier'),
    sudoers: '/etc/sudoers.d/openswarm-verifier',
  } as const
}

/** {@link verifierInstall} on this host. */
export const VERIFIER_INSTALL = verifierInstall()

/** The helper's source, which setup installs (and tests run as themselves). */
export function verifierHelperSource(): string {
  return fileURLToPath(new URL('../verifier-helper.mjs', import.meta.url))
}

/** sudo, by absolute path: a `sudo` found on PATH could be anyone's. */
export const SUDO = '/usr/bin/sudo'

export interface Verifier {
  /** Runs the helper as the verifier user: `/usr/bin/sudo -n -u <user> <helper>`. */
  command: string[]
  /** The verifier user, which a member has no reason to name. */
  user: string
}

/**
 * The installed verifier: always `/usr/bin/sudo -n -u <user> <helper>`, from
 * where setup installs it. No environment variable changes it; anything that
 * could set one (a member writing the operator's shell profile, say) could
 * otherwise swap in a helper of its own that says whatever it likes.
 */
export function installedVerifier(): Verifier {
  return { command: [SUDO, '-n', '-u', VERIFIER_INSTALL.user, VERIFIER_INSTALL.helper], user: VERIFIER_INSTALL.user }
}

let injected: Verifier | undefined

/**
 * Tests only: run the helper some other way in this process (a copy, as the
 * test's own user, against a temp store), or `undefined` for the installed
 * one again. Code, never the environment, so nothing outside this process
 * reaches it; `RunTeamOptions.verifier` is the same, per run.
 */
export function injectVerifierForTests(verifier: Verifier | undefined): void {
  injected = verifier
}

/** The verifier this process uses: one a test injected, else the installed one. */
export function activeVerifier(): Verifier {
  return injected ?? installedVerifier()
}

/**
 * The pids of the helper processes this process started (sudo's, or the
 * helper's own when run directly): the gate's invocations, which the tamper
 * scan does not count against a member.
 */
const own = new Set<number>()

/** One helper call: its one line of JSON, or the error it reported. */
function call(v: Verifier, args: string[], options: { stdin?: NodeJS.ReadableStream; signal?: AbortSignal } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(v.command[0]!, [...v.command.slice(1), ...args], {
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (child.pid !== undefined) own.add(child.pid)
    if (options.stdin !== undefined) {
      options.stdin.pipe(child.stdin!)
      // A helper that refuses early closes its stdin; that is its answer, not a crash here.
      child.stdin!.on('error', () => undefined)
    }
    let out = ''
    let err = ''
    child.stdout!.on('data', (chunk) => (out += chunk))
    child.stderr!.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      let parsed: any
      try {
        parsed = JSON.parse(out.trim().split('\n').at(-1) ?? '')
      } catch {}
      if (code === 0 && parsed !== undefined && parsed.error === undefined) resolve(parsed)
      else reject(new Error(`verifier ${args[0]}: ${parsed?.error ?? (err.trim().split('\n').at(-1) || `exit ${code}`)}`))
    })
  })
}

/** L3 makes no sense for a root operator: root reads any file, the store included. */
export function refuseRootForL3(): void {
  if (process.getuid?.() === 0) {
    throw new Error('L3 (a hidden suite) needs members that are not root: root reads any file, the verifier store included. Run as a regular user, or gate at L2.')
  }
}

/** What a run's L3 gates share: the store and every suite's canary ids, and the helper log's cursor at the start. */
export interface VerifierSession {
  verifier: Verifier
  store: string
  /** The host can only confine a run partly, and the operator allowed it (OPENSWARM_VERIFIER_ALLOW_PARTIAL=1). */
  allowPartial: boolean
  /** Ids of the canaries in the suites' files (see {@link canaryId}); the canaries themselves never leave the verifier. */
  canaries: string[]
  /** The log's last seq before the run's first round; scans read after it. */
  cursor: number
}

/**
 * Check the verifier before any spend: not root; the helper answers, holds
 * every suite named, and can fully confine a run, or the operator allows
 * partial (`OPENSWARM_VERIFIER_ALLOW_PARTIAL=1`, which only weakens what the
 * evidence counts as). Then the log cursor the tamper scans start from.
 */
export async function openVerifier(verifier: Verifier, suites: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<VerifierSession> {
  refuseRootForL3()
  let listed: { store: string; enforcement: string; suites: { name: string; canaries: string[] }[] }
  try {
    listed = await call(verifier, ['list'])
  } catch (error) {
    throw new Error(`the L3 verifier is not reachable (${error instanceof Error ? error.message : String(error)}); see \`openswarm verifier status\``)
  }
  const missing = suites.filter((name) => !listed.suites.some((s) => s.name === name))
  if (missing.length > 0) throw new Error(`the verifier holds no suite ${missing.map((m) => `"${m}"`).join(', ')}; add it with \`openswarm verifier add-suite\``)
  const allowPartial = env['OPENSWARM_VERIFIER_ALLOW_PARTIAL'] === '1'
  if (listed.enforcement !== 'full' && !allowPartial) {
    throw new Error(
      'this host cannot fully confine a hidden suite\'s run (no Seatbelt or bwrap), so its code could write the suite where a member reads it: ' +
        'install bwrap, or set OPENSWARM_VERIFIER_ALLOW_PARTIAL=1 to run anyway (such evidence counts as L2)',
    )
  }
  const { cursor } = await call(verifier, ['log'])
  return { verifier, store: listed.store, allowPartial, canaries: listed.suites.flatMap((s) => s.canaries), cursor }
}

/** Run `suite` on `commit` of the repository at `repo`: `git archive` into the helper, its summary back. */
export async function runHiddenSuite(session: VerifierSession, suite: string, repo: string, commit: string, envRoot: string): Promise<HiddenSummary> {
  const archive = spawn('git', ['archive', '--format=tar', commit], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  let archiveError = ''
  archive.stderr.on('data', (chunk) => (archiveError += chunk))
  const archived = new Promise<void>((resolve, reject) =>
    archive.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git archive ${commit}: ${archiveError.trim() || `exit ${code}`}`)))),
  )
  const [summary] = await Promise.all([call(session.verifier, ['run', suite, '--env-root', envRoot], { stdin: archive.stdout }), archived])
  for (const key of ['total', 'failed', 'durationMs'] as const) {
    if (!Number.isInteger(summary?.[key])) throw new Error(`verifier run: no ${key} in its summary`)
  }
  return {
    passed: summary.passed === true,
    total: summary.total,
    failed: summary.failed,
    durationMs: summary.durationMs,
    enforcement: summary.enforcement === 'full' ? 'full' : 'partial',
    ...(typeof summary.refused === 'string' ? { refused: summary.refused } : {}),
  }
}

/** One record of the helper's invocation log, as `log` returns it. */
export interface VerifierLogEntry {
  seq: number
  time: number
  uid: number
  pid: number
  /** The caller's ancestry, nearest first (sudo, then whoever ran it). */
  ancestors: { pid: number; comm: string }[]
  event: 'start' | 'end'
  cmd: string
  suite?: string
}

export interface TamperPatterns {
  store: string
  helper: string
  user: string
  /** Canary ids. */
  canaries: readonly string[]
}

/** A canary as the helper writes it into a suite's files. */
const CANARY = /openswarm-canary-[0-9a-f]{24}/g

/** The id `list` gives a canary: a hash, so the list (no password needed) never gives a member the canary itself. */
export function canaryId(canary: string): string {
  return createHash('sha256').update(canary).digest('hex').slice(0, 16)
}

const DENIED = /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/i

/** One tool call of a member's round, as text, and what came back. */
export interface ToolExchange {
  call: string
  result: string
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Which verifier names a line holds: the store's path (also as a shell spells a space, `\ `), the helper's, the user's. */
function mentions(line: string, p: TamperPatterns): { store?: string; helper?: string; user?: string } {
  const helper = [p.helper, dirname(p.helper)].find((h) => line.includes(h))
  return {
    ...([p.store, p.store.replaceAll(' ', '\\ ')].some((s) => line.includes(s)) ? { store: p.store } : {}),
    ...(helper === undefined ? {} : { helper }),
    ...(new RegExp(`(^|[^\\w-])${escape(p.user)}($|[^\\w-])`).test(line) ? { user: p.user } : {}),
  }
}

/**
 * Signs in `text` (a diff's added lines, or any transcript text) that name
 * the verifier: its store's or helper's path or its user, each `advisory`
 * alone, since anyone can write a name (a sibling planting it, a repository
 * that documents the verifier); and a suite's canary, an `incident` (recorded
 * by its id), since a canary exists only in the suite's own files.
 */
export function scanText(text: string, where: TamperSignal['where'], p: TamperPatterns): TamperSignal[] {
  const signals: TamperSignal[] = []
  for (const line of text.split('\n')) {
    const m = mentions(line, p)
    if (m.store !== undefined) add(signals, { signal: 'store-path', severity: 'advisory', where, match: m.store })
    if (m.helper !== undefined) add(signals, { signal: 'helper-path', severity: 'advisory', where, match: m.helper })
    if (m.user !== undefined) add(signals, { signal: 'verifier-user', severity: 'advisory', where, match: m.user })
    for (const canary of line.match(CANARY) ?? []) {
      const id = canaryId(canary)
      if (p.canaries.includes(id)) add(signals, { signal: 'canary', severity: 'incident', where, match: `canary ${id}` })
    }
  }
  return signals
}

/** Each signal once. */
function add(signals: TamperSignal[], signal: TamperSignal): void {
  if (!signals.some((s) => s.signal === signal.signal && s.match === signal.match && s.where === signal.where)) signals.push(signal)
}

/**
 * A round's tool calls and their results: every name and canary as in
 * {@link scanText}, and two incidents a planted text cannot fake, since they
 * need the member's own command: sudo aimed at the verifier user or helper,
 * and a denied access to a verifier path by a command that named one.
 */
export function scanTranscript(exchanges: readonly ToolExchange[], p: TamperPatterns): TamperSignal[] {
  const signals: TamperSignal[] = []
  for (const { call, result } of exchanges) {
    for (const s of scanText(`${call}\n${result}`, 'transcript', p)) add(signals, s)
    const named = call.split('\n').map((line) => mentions(line, p))
    for (const [i, line] of call.split('\n').entries()) {
      if (/\bsudo\b/.test(line) && (named[i]!.user !== undefined || named[i]!.helper !== undefined)) {
        add(signals, { signal: 'sudo', severity: 'incident', where: 'transcript', match: named[i]!.user !== undefined ? `sudo -u ${p.user}` : `sudo ${named[i]!.helper}` })
      }
    }
    if (!named.some((m) => m.store !== undefined || m.helper !== undefined)) continue
    for (const line of result.split('\n')) {
      const m = mentions(line, p)
      const path = m.store ?? m.helper
      if (DENIED.test(line) && path !== undefined) add(signals, { signal: 'permission-denied', severity: 'incident', where: 'transcript', match: path })
    }
  }
  return signals
}

/**
 * Helper invocations in the log that the gate did not make, started inside
 * `window` (a member's turn), by a descendant of this process (a member's
 * shell) or by a process orphaned near the call (a member's detached job):
 * incidents, since only a call makes them. ponytail: an unrelated process's
 * call is told apart only by its ancestry, and parallel in-process members
 * share it, so one member's call lands on every turn it overlaps.
 */
export function scanLog(entries: readonly VerifierLogEntry[], window: { from: number; to: number }, self = process.pid): TamperSignal[] {
  return entries
    .filter((e) => e.event === 'start' && e.time >= window.from && e.time <= window.to)
    .filter((e) => !own.has(e.pid) && !own.has(e.ancestors?.[0]?.pid ?? -1))
    .filter((e) => (e.ancestors ?? []).some((a) => a.pid === self) || (e.ancestors ?? []).slice(0, 3).some((a) => a.pid === 1))
    .map((e) => ({
      signal: 'helper-log',
      severity: 'incident',
      where: 'helper log',
      match: `${e.cmd}${e.suite === undefined ? '' : ` ${e.suite}`} by ${(e.ancestors ?? []).slice(0, 3).map((a) => `${a.comm}[${a.pid}]`).join(' < ')}`,
    }))
}

/** The lines a diff adds, from `before` to `after`, in the repository at `cwd`. */
async function addedLines(cwd: string, before: string, after: string): Promise<string> {
  let out: string
  try {
    out = (await execFileAsync('git', ['diff', '--no-ext-diff', '--no-color', '-U0', before, after], { cwd, maxBuffer: 64 << 20 })).stdout
  } catch (error) {
    // ponytail: a diff past 64 MiB is scanned as far as it got.
    out = String((error as { stdout?: string }).stdout ?? '')
  }
  return out
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n')
}

/**
 * A board task's or the single path's L3 source: `suite` run on each round's
 * snapshot, and the scan of each round for tamper signs. `transcript` gives
 * the round's tool calls and outputs (see {@link recordToolEvents}).
 */
export function hiddenSuite(
  session: VerifierSession,
  options: {
    suite: string
    /** The tree the member edits: where `git archive` and `git diff` run. */
    cwd: () => Promise<string>
    /** Where the run borrows ignored environment directories from (node_modules, .venv…). */
    envRoot: string
    transcript?: (result: MemberRunResult, startedAt: number) => ToolExchange[] | Promise<ToolExchange[]>
  },
): HiddenSuite {
  const patterns: TamperPatterns = {
    store: session.store,
    helper: session.verifier.command.at(-1)!,
    user: session.verifier.user,
    canaries: session.canaries,
  }
  return {
    suite: options.suite,
    allowPartial: session.allowPartial,
    run: async (commit) => runHiddenSuite(session, options.suite, await options.cwd(), commit, options.envRoot),
    scan: async ({ result, before, after, startedAt }) => {
      const to = Date.now()
      const transcript = (await options.transcript?.(result, startedAt)) ?? []
      const diff = await addedLines(await options.cwd(), before, after)
      // ponytail: rereads the log since the run began on every scan; keep a cursor per window if logs grow long.
      const { entries } = await call(session.verifier, ['log', '--since', String(session.cursor)])
      return [
        ...scanTranscript(transcript, patterns),
        ...scanText(diff, 'diff', patterns),
        ...scanLog(entries, { from: startedAt, to }),
      ]
    },
  }
}

/**
 * Every string inside `value`, one per line: a tool call's arguments, a
 * result's text. Arguments kept as JSON text are parsed first, or their
 * escaping (`\\ ` for a shell's `\ `) would hide a path.
 */
function strings(value: unknown): string {
  if (typeof value === 'string') {
    if (/^\s*[[{]/.test(value)) {
      try {
        return strings(JSON.parse(value))
      } catch {}
    }
    return value
  }
  if (Array.isArray(value)) return value.map(strings).filter((s) => s !== '').join('\n')
  if (value !== null && typeof value === 'object') return Object.values(value).map(strings).filter((s) => s !== '').join('\n')
  return ''
}

/** Tool events in order as exchanges: each call with the result that names its id. */
function exchanges(events: readonly { type: string; data: any }[]): ToolExchange[] {
  const out: ToolExchange[] = []
  const byId = new Map<string, ToolExchange>()
  for (const { type, data } of events) {
    if (type === 'tool/call') {
      const exchange = { call: strings({ name: data?.name, arguments: data?.arguments }), result: '' }
      out.push(exchange)
      byId.set(String(data?.callId), exchange)
    } else if (type === 'tool/result') {
      const exchange = byId.get(String(data?.message?.source?.callId))
      const text = strings(data?.message?.content ?? data)
      if (exchange === undefined) out.push({ call: '', result: text })
      else exchange.result = exchange.result === '' ? text : `${exchange.result}\n${text}`
    }
  }
  return out
}

/**
 * In-process members' tool calls and results, per session, live off
 * `session/event`: the transcript the tamper scan reads. `take` hands over a
 * session's and forgets it. ponytail: sessions never taken stay in memory
 * until `dispose`, so it is mounted only while an L3 gate runs.
 */
export function recordToolEvents(ctx: Context): { take(sessionId: string): ToolExchange[]; dispose(): void } {
  const sessions = new Map<string, { type: string; data: unknown }[]>()
  const dispose = ctx.on('session/event' as any, (session: any, event: any) => {
    if (event?.type !== 'tool/call' && event?.type !== 'tool/result') return
    const id = String(session?.id)
    sessions.set(id, [...(sessions.get(id) ?? []), { type: event.type, data: event.data }])
  })
  return {
    take(sessionId) {
      const events = sessions.get(sessionId) ?? []
      sessions.delete(sessionId)
      return exchanges(events)
    },
    dispose: () => void dispose(),
  }
}

/**
 * Tool calls and results in the session logs under `root` written since
 * `since`: a subprocess member's transcript, which never reaches this
 * process's events. ponytail: picked by file time, so a sibling member's log
 * written in the same window is read too, and its signals land on this task.
 */
export function toolEventsFromLogs(root: string, since: number): ToolExchange[] {
  if (!existsSync(root)) return []
  const out: ToolExchange[] = []
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const path = join(root, file)
    if (!file.endsWith('.jsonl') || statSync(path).mtimeMs < since) continue
    const events: { type: string; data: unknown }[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      try {
        const event = JSON.parse(line)
        if (event?.type === 'tool/call' || event?.type === 'tool/result') events.push(event)
      } catch {}
    }
    out.push(...exchanges(events))
  }
  return out
}

/**
 * A ustar archive of the regular files under `dir` (what `add-suite` reads).
 * Refuses a symlink or other special file, as the helper would, and a path
 * longer than ustar holds.
 */
export function tarDirectory(dir: string): Buffer {
  const blocks: Buffer[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name)
      const rel = relative(dir, path).split(sep).join('/')
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) blocks.push(...tarEntry(rel, readFileSync(path), statSync(path).mode & 0o777))
      else throw new Error(`${rel} is not a regular file; a suite holds files only`)
    }
  }
  walk(dir)
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

/** One file as ustar header and padded body. */
export function tarEntry(path: string, data: Buffer, mode = 0o644, type = '0', linkname = ''): Buffer[] {
  const header = Buffer.alloc(512)
  // A path past 100 bytes splits at a slash into prefix (155) and name (100).
  const cut = path.length <= 100 ? -1 : path.indexOf('/', path.length - 101)
  const [prefix, name] = cut < 0 ? ['', path] : [path.slice(0, cut), path.slice(cut + 1)]
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`${path}: too long for a ustar archive`)
  const put = (value: string, at: number, len: number) => header.write(value, at, len, 'utf8')
  const num = (value: number, at: number, len: number) => put(`${value.toString(8).padStart(len - 1, '0')}\0`, at, len)
  put(name, 0, 100)
  num(mode, 100, 8)
  num(0, 108, 8)
  num(0, 116, 8)
  num(data.length, 124, 12)
  num(0, 136, 12)
  put('        ', 148, 8)
  put(type, 156, 1)
  put(linkname, 157, 100)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  put(prefix, 345, 155)
  let sum = 0
  for (const byte of header) sum += byte
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]
}
