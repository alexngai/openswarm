/**
 * openswarm-verifier: the L3 verifier's helper (docs/05 B1, D4).
 *
 * It runs as the verifier user, through sudo, and is the only thing that ever
 * reads the hidden-suite store: members run as the operator, the store is the
 * verifier user's with mode 0700, so the kernel denies them it. Everything
 * this file is handed (argv, stdin, the environment root) can come from a
 * process a member controls, since `run`, `list` and `log` need no password,
 * so it validates all of it: it is the trust boundary. Its own settings (the
 * store) come from config.json beside it, which setup installs root-owned,
 * never from argv or the environment. Node built-ins only: a module resolved
 * from anywhere a member can write would run as the verifier.
 *
 *   add-suite <name>             a tar on stdin: test files and openswarm-suite.json
 *   remove-suite <name>
 *   run <name> --env-root <dir>  a snapshot tar on stdin; prints a summary and nothing else
 *   list                         suite names and canary ids (no content), and how runs are confined
 *   log [--since <seq>]          invocations after a cursor, summary fields only
 *
 * Every invocation is logged, when it starts and when it ends, with the
 * caller's uid and process ancestry, so the gate can tell its own calls from
 * a member's (the tamper scan). Output is one line of JSON on stdout.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, join, posix, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'))
const STORE = config.store
const SUITES = join(STORE, 'suites')
const RUNS = join(STORE, 'runs')
const LOG = join(STORE, 'log.jsonl')
/** Caps on stdin. ponytail: a snapshot is held in memory; stream it if repositories outgrow 1 GiB. */
const MAX_SUITE_BYTES = config.maxSuiteBytes ?? 64 << 20
const MAX_SNAPSHOT_BYTES = config.maxSnapshotBytes ?? 1 << 30
const MANIFEST = 'openswarm-suite.json'
const NAME = /^[a-z0-9-]{1,64}$/
/** Ignored environment directories a run borrows from --env-root, wherever the snapshot has their parent. */
const ENV_NAMES = ['node_modules', '.venv', 'venv', 'dist', 'build', 'target', '.tox', '__pypackages__']
/** Line comments by extension, for the canary; a file of any other kind gets none. */
const COMMENT = {
  '#': ['.py', '.rb', '.sh', '.bash', '.pl', '.r', '.toml', '.yaml', '.yml', '.cfg', '.ini', '.ex', '.exs', '.jl', '.feature'],
  '//': ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.dart', '.php', '.zig', '.groovy'],
  '--': ['.sql', '.lua', '.hs', '.elm'],
}

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message)
}

// ---------------------------------------------------------------- the log

/** The caller's process ancestry, nearest first: who ran sudo, and who ran them. */
function ancestors() {
  const out = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout ?? ''
  const table = new Map()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim().split('/').pop() })
  }
  const chain = []
  for (let pid = process.ppid; pid > 0 && chain.length < 16; pid = table.get(pid)?.ppid ?? 0) {
    chain.push({ pid, comm: table.get(pid)?.comm ?? '?' })
    if (pid === 1) break
  }
  return chain
}

let caller

function log(entry) {
  appendFileSync(LOG, `${JSON.stringify({ time: Date.now(), ...caller, ...entry })}\n`)
}

// ---------------------------------------------------------------- tar

function octal(buf, at, len) {
  const text = buf.subarray(at, at + len).toString('latin1').replace(/\0.*$/s, '').trim()
  if (text !== '' && !/^[0-7]+$/.test(text)) refuse('tar: a header field is not octal')
  return text === '' ? 0 : parseInt(text, 8)
}

const cstring = (buf, at, len) => buf.subarray(at, at + len).toString('utf8').replace(/\0.*$/s, '')

/** A pax extended header's records (`<len> key=value\n`). */
function pax(body) {
  const out = {}
  for (let at = 0; at < body.length; ) {
    const space = body.indexOf(0x20, at)
    const len = Number(body.subarray(at, space).toString('latin1'))
    if (space < 0 || !Number.isInteger(len) || len <= 0) refuse('tar: a malformed pax header')
    const record = body.subarray(space + 1, at + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    out[record.slice(0, eq)] = record.slice(eq + 1)
    at += len
  }
  return out
}

/** A tar path, checked and made relative: nothing absolute, no `..`, no NUL or backslash. */
function entryPath(raw) {
  if (raw.includes('\0') || raw.includes('\\')) refuse(`tar: an unsafe path: ${JSON.stringify(raw)}`)
  if (raw.startsWith('/')) refuse(`tar: an absolute path: ${raw}`)
  if (raw.split('/').includes('..')) refuse(`tar: a path that climbs out: ${raw}`)
  const path = posix.normalize(raw).replace(/\/+$/, '')
  return path === '.' ? '' : path.replace(/^\.\//, '')
}

/**
 * The entries of a ustar/pax tar (what `git archive` and `tar` write): files,
 * directories and, with `links`, symlinks. Any other type (a hard link, a
 * device, a FIFO) is refused, as is anything malformed.
 */
function parseTar(buf, { links = false } = {}) {
  const entries = []
  let next = {}
  for (let at = 0; at + 512 <= buf.length; ) {
    const header = buf.subarray(at, at + 512)
    if (header.every((b) => b === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
    if (sum !== octal(header, 148, 8)) refuse('tar: a header checksum does not match')
    if (header[124] & 0x80) refuse('tar: an entry too large for this verifier')
    const size = octal(header, 124, 12)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const body = buf.subarray(at + 512, at + 512 + size)
    if (body.length < size) refuse('tar: truncated')
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'g') continue
    if (type === 'x') {
      const records = pax(body)
      next = { path: records.path, linkpath: records.linkpath }
      continue
    }
    if (type === 'L' || type === 'K') {
      next[type === 'L' ? 'path' : 'linkpath'] = body.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    const prefix = header.subarray(257, 262).toString('latin1') === 'ustar' ? cstring(header, 345, 155) : ''
    const raw = next.path ?? (prefix === '' ? cstring(header, 0, 100) : `${prefix}/${cstring(header, 0, 100)}`)
    const target = next.linkpath ?? cstring(header, 157, 100)
    next = {}
    const path = entryPath(raw)
    if (type === '5') {
      entries.push({ type: 'dir', path })
      continue
    }
    if (path === '') refuse('tar: an entry with an empty path')
    if (type === '0' || type === '7') entries.push({ type: 'file', path, mode: octal(header, 100, 8), data: body })
    else if (type === '2' && links) entries.push({ type: 'symlink', path, target })
    else refuse(`tar: ${path} is a ${{ 1: 'hard link', 2: 'symlink', 3: 'device', 4: 'device', 6: 'FIFO' }[type] ?? `type ${type} entry`}, which is not accepted here`)
  }
  return entries
}

/**
 * Write `entries` under `root`, which this process just made. Files never
 * follow or replace anything (O_EXCL), and symlinks come last, so no file is
 * written through a link the tar made; nor is a link made through one (a link
 * under another link's path), which would land outside `root`, in the store.
 */
function extract(entries, root) {
  const links = new Set(entries.filter((e) => e.type === 'symlink').map((e) => e.path))
  for (const path of links) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (links.has(parts.slice(0, i).join('/'))) refuse(`tar: ${path} is under the link ${parts.slice(0, i).join('/')}`)
    }
  }
  for (const e of entries) {
    const to = join(root, e.path)
    if (e.type === 'dir') mkdirSync(to, { recursive: true })
    else if (e.type === 'file') {
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, e.data, { flag: 'wx', mode: e.mode & 0o111 ? 0o700 : 0o600 })
    }
  }
  for (const e of entries) {
    if (e.type !== 'symlink') continue
    mkdirSync(dirname(join(root, e.path)), { recursive: true })
    symlinkSync(e.target, join(root, e.path))
  }
}

/** A few milliseconds' sleep, for a non-blocking stdin with nothing to read yet. */
const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)

function readStdin(cap) {
  const chunks = []
  const buf = Buffer.alloc(1 << 16)
  for (let total = 0; ; ) {
    let n
    try {
      n = readSync(0, buf, 0, buf.length, null)
    } catch (error) {
      if (error.code === 'EAGAIN') {
        nap()
        continue
      }
      if (error.code === 'EOF') break
      throw error
    }
    if (n === 0) break
    total += n
    if (total > cap) refuse(`stdin is over the ${cap}-byte cap`)
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------- the store

function initStore() {
  if (!existsSync(STORE)) refuse(`no store at ${STORE}; run \`openswarm verifier setup\``)
  for (const dir of [SUITES, RUNS]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!existsSync(LOG)) writeFileSync(LOG, '', { mode: 0o600 })
}

function suiteDir(name) {
  if (typeof name !== 'string' || !NAME.test(name)) refuse('a suite name is 1-64 of [a-z0-9-]')
  return join(SUITES, name)
}

function manifestOf(name) {
  const path = join(suiteDir(name), 'manifest.json')
  if (!existsSync(path)) refuse(`no suite "${name}"`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Every directory under `path` to `dirMode` and file to `fileMode`; symlinks are not followed. */
function chmodTree(path, fileMode, dirMode) {
  chmodSync(path, 0o700)
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) chmodTree(child, fileMode, dirMode)
    else if (entry.isFile()) chmodSync(child, fileMode)
  }
  chmodSync(path, dirMode)
}

/** The suite's manifest as stored: what to run, and how to count. */
function checkManifest(raw) {
  let m
  try {
    m = JSON.parse(raw)
  } catch {
    refuse(`${MANIFEST} is not JSON`)
  }
  if (typeof m?.command !== 'string' || m.command.trim() === '' || m.command.length > 4096) {
    refuse(`${MANIFEST} needs a "command" of 1-4096 characters ({work} is the snapshot, {suite} the suite)`)
  }
  if (m.junit !== undefined && (typeof m.junit !== 'string' || isAbsolute(m.junit) || m.junit.split('/').includes('..'))) {
    refuse(`${MANIFEST}: "junit" is a path relative to {work}`)
  }
  if (m.timeoutMs !== undefined && !(Number.isInteger(m.timeoutMs) && m.timeoutMs >= 1000 && m.timeoutMs <= 3_600_000)) {
    refuse(`${MANIFEST}: "timeoutMs" is 1000-3600000`)
  }
  return { command: m.command, ...(m.junit === undefined ? {} : { junit: m.junit }), timeoutMs: m.timeoutMs ?? 600_000 }
}

function addSuite(name) {
  const dir = suiteDir(name)
  if (existsSync(dir)) refuse(`suite "${name}" exists; remove-suite it first`)
  const entries = parseTar(readStdin(MAX_SUITE_BYTES))
  const manifest = entries.find((e) => e.type === 'file' && e.path === MANIFEST)
  if (manifest === undefined) refuse(`the suite's tar has no ${MANIFEST} at its root`)
  const stored = checkManifest(manifest.data.toString('utf8'))
  const files = entries.filter((e) => e.type === 'file' && e.path !== MANIFEST)
  if (files.length === 0) refuse('the suite has no test files')
  const canaries = {}
  for (const f of files) {
    const mark = Object.entries(COMMENT).find(([, exts]) => exts.includes(extname(f.path).toLowerCase()))?.[0]
    if (mark === undefined) continue
    // At the end, where a comment is safe past any shebang, encoding cookie or `from __future__`.
    const canary = `openswarm-canary-${randomBytes(12).toString('hex')}`
    const newline = f.data.length > 0 && f.data.at(-1) !== 0x0a ? '\n' : ''
    f.data = Buffer.concat([f.data, Buffer.from(`${newline}${mark} ${canary}\n`)])
    canaries[f.path] = canary
  }
  const staging = mkdtempSync(join(SUITES, '.add-'))
  try {
    extract([...entries.filter((e) => e.type === 'dir'), ...files], join(staging, 'tests'))
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ ...stored, canaries }, null, 1))
    // Read-only even to its owner: a run's leftover process racing the removal
    // of its run directory with a symlink cannot delete a suite through it.
    chmodTree(staging, 0o400, 0o500)
    renameSync(staging, dir)
  } catch (error) {
    if (existsSync(staging)) chmodTree(staging, 0o600, 0o700)
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return { suite: name, files: files.length, canaries: Object.keys(canaries).length }
}

function removeSuite(name) {
  const dir = suiteDir(name)
  if (!existsSync(dir)) refuse(`no suite "${name}"`)
  chmodTree(dir, 0o600, 0o700)
  rmSync(dir, { recursive: true, force: true })
  return { removed: name }
}

/**
 * A canary's id: what `list` shows (it needs no password, so a member can
 * call it), from which no one can make the canary. The gate hashes the
 * canary-shaped strings it finds and compares.
 */
const canaryId = (canary) => createHash('sha256').update(canary).digest('hex').slice(0, 16)

function list() {
  const suites = readdirSync(SUITES)
    .filter((name) => NAME.test(name))
    .map((name) => ({ name, canaries: Object.values(manifestOf(name).canaries ?? {}).map(canaryId) }))
  return { store: STORE, enforcement: confinement().enforcement, suites }
}

/** Log entries after `since` (each written here, so a summary) and the cursor to pass next. */
function readLog(since) {
  const lines = readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== '')
  const entries = []
  lines.forEach((line, seq) => {
    if (seq > since) entries.push({ seq, ...JSON.parse(line) })
  })
  return { cursor: lines.length - 1, entries }
}

// ---------------------------------------------------------------- run

const quote = (path) => `'${path.replaceAll("'", `'\\''`)}'`

/**
 * How this host confines a run: no network, writes only under the run's own
 * directory, the store hidden but for the run's copy of its suite. `full`
 * where the platform does all of it (macOS Seatbelt, Linux bwrap); else
 * `partial` (unshare still cuts the network, or nothing does). The gate
 * refuses L3 on a `partial` host unless the operator allows it, and never
 * counts a `partial` run as L3 (docs/05 B1). Probed once per call.
 */
function confinement() {
  if (process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0) {
    return {
      enforcement: 'full',
      wrap: (runDir, work, argv) => {
        const s = (path) => JSON.stringify(path)
        const store = realpathSync(STORE)
        const run = realpathSync(runDir)
        const profile = [
          '(version 1)',
          '(allow default)',
          '(deny network*)',
          // Shared memory a member made world-writable would be a channel out.
          '(deny ipc-posix-shm* ipc-sysv-shm ipc-sysv-msg)',
          '(deny file-write*)',
          `(allow file-write* (literal "/dev/null") (subpath ${s(run)}))`,
          `(deny file-read* (subpath ${s(store)}))`,
          `(allow file-read* (subpath ${s(run)}))`,
          `(allow file-read-metadata (literal ${s(store)}) (literal ${s(join(store, 'runs'))}))`,
        ].join('\n')
        return ['/usr/bin/sandbox-exec', '-p', profile, ...argv]
      },
    }
  }
  if (process.platform === 'linux') {
    const bwrap = ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-net', '--unshare-ipc', '--unshare-pid', '--die-with-parent', '--new-session']
    if (existsSync(bwrap[0]) && spawnSync(bwrap[0], [...bwrap.slice(1), '/bin/true']).status === 0) {
      return { enforcement: 'full', wrap: (runDir, work, argv) => [...bwrap, '--tmpfs', STORE, '--bind', runDir, runDir, '--chdir', work, ...argv] }
    }
    if (spawnSync('/usr/bin/unshare', ['--net', '--map-root-user', '/bin/true']).status === 0) {
      return { enforcement: 'partial', wrap: (_runDir, _work, argv) => ['/usr/bin/unshare', '--net', '--map-root-user', ...argv] }
    }
  }
  return { enforcement: 'partial', wrap: (_runDir, _work, argv) => argv }
}

/** Symlink --env-root's environment directories into the work tree, wherever the snapshot has the parent and not the directory. */
function linkEnvironment(envRoot, work) {
  let visited = 0
  const walk = (rel, depth) => {
    if (++visited > 20_000) return
    for (const name of ENV_NAMES) {
      const from = join(envRoot, rel, name)
      const to = join(work, rel, name)
      try {
        if (!existsSync(to) && statSync(from).isDirectory()) symlinkSync(from, to)
      } catch {}
    }
    if (depth >= 6) return
    for (const entry of readdirSync(join(work, rel), { withFileTypes: true })) {
      if (entry.isDirectory() && !ENV_NAMES.includes(entry.name) && entry.name !== '.git') walk(join(rel, entry.name), depth + 1)
    }
  }
  walk('', 0)
}

/** Tests and failures in a JUnit report the run wrote inside its own directory; undefined when there is none to trust. */
function junitCounts(path, runDir) {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > 16 << 20 || !realpathSync(path).startsWith(realpathSync(runDir) + sep)) return undefined
    let total = 0
    let failed = 0
    for (const m of readFileSync(path, 'utf8').matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      total++
      if (/<(failure|error)\b/.test(m[1] ?? '')) failed++
    }
    return total === 0 ? undefined : { total, failed }
  } catch {
    return undefined
  }
}

async function runSuite(name, envRootArg) {
  const manifest = manifestOf(name)
  if (!isAbsolute(envRootArg)) refuse('--env-root takes an absolute path')
  let envRoot
  try {
    envRoot = realpathSync(envRootArg)
    if (!statSync(envRoot).isDirectory()) throw new Error()
  } catch {
    refuse('--env-root is not a directory')
  }
  for (const kept of [STORE, here]) {
    const k = realpathSync(kept)
    if (envRoot === k || envRoot.startsWith(k + sep) || k.startsWith(envRoot + sep)) refuse('--env-root may not hold or be inside the verifier')
  }
  const { enforcement, wrap } = confinement()
  const runDir = mkdtempSync(join(RUNS, 'run-'))
  try {
    const work = join(runDir, 'work')
    const suite = join(runDir, 'suite')
    for (const dir of [work, join(runDir, 'home'), join(runDir, 'tmp')]) mkdirSync(dir)
    // A snapshot this refuses is the member's to fix, so it is a result (a
    // failed round), not a verifier failure; the reason names its own paths only.
    try {
      extract(parseTar(readStdin(MAX_SNAPSHOT_BYTES), { links: true }), work)
    } catch (error) {
      const refused = error instanceof Refused ? error.message : `tar: ${error?.code ?? 'unreadable'}`
      return { passed: false, total: 0, failed: 0, durationMs: 0, enforcement, refused }
    }
    linkEnvironment(envRoot, work)
    // The run's own copy, writable (caches, __pycache__); the store's stays out of reach.
    cpSync(join(suiteDir(name), 'tests'), suite, { recursive: true })
    chmodTree(suite, 0o600, 0o700)
    const command = manifest.command.replaceAll('{work}', quote(work)).replaceAll('{suite}', quote(suite))
    const argv = wrap(runDir, work, ['/bin/bash', '-c', command])
    const started = Date.now()
    const { code, timedOut } = await new Promise((resolve) => {
      // Nothing the run prints is passed on: test names, output and source stay here.
      const child = spawn(argv[0], argv.slice(1), {
        cwd: work,
        stdio: 'ignore',
        detached: true,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: join(runDir, 'home'),
          TMPDIR: join(runDir, 'tmp'),
          LANG: 'C.UTF-8',
          CI: '1',
        },
      })
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
      const timer = setTimeout(() => {
        kill()
        resolve({ code: -1, timedOut: true })
      }, manifest.timeoutMs)
      child.on('error', () => {
        clearTimeout(timer)
        resolve({ code: -1, timedOut: false })
      })
      child.on('exit', (exit) => {
        clearTimeout(timer)
        kill()
        resolve({ code: exit ?? -1, timedOut: false })
      })
    })
    const durationMs = Date.now() - started
    const counts = manifest.junit === undefined ? undefined : junitCounts(join(work, manifest.junit), runDir)
    const passed = code === 0 && !timedOut && (manifest.junit === undefined || (counts !== undefined && counts.failed === 0))
    // Without a report the suite is one test; a declared report that is missing counts as one failure.
    const { total, failed } = counts ?? { total: 1, failed: passed ? 0 : 1 }
    return { passed, total, failed: passed ? 0 : Math.max(failed, 1), durationMs, enforcement }
  } finally {
    try {
      chmodTree(runDir, 0o600, 0o700)
    } catch {}
    rmSync(runDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- main

async function main([cmd, ...rest]) {
  if (process.getuid() === 0) refuse('the verifier must not run as root')
  initStore()
  caller = {
    /** sudo's record of who ran it (the wrapper keeps it); without sudo (tests), this process's uid. */
    uid: Number(process.env.SUDO_UID || process.getuid()),
    pid: process.pid,
    ancestors: ancestors(),
  }
  const what = { cmd: String(cmd).slice(0, 32), ...(['add-suite', 'remove-suite', 'run'].includes(cmd) && typeof rest[0] === 'string' ? { suite: rest[0].slice(0, 64) } : {}) }
  log({ event: 'start', ...what })
  try {
    let result
    if (cmd === 'add-suite' && rest.length === 1) result = addSuite(rest[0])
    else if (cmd === 'remove-suite' && rest.length === 1) result = removeSuite(rest[0])
    else if (cmd === 'run' && rest.length === 3 && rest[1] === '--env-root') result = await runSuite(rest[0], rest[2])
    else if (cmd === 'list' && rest.length === 0) result = list()
    else if (cmd === 'log' && rest.length === 0) result = readLog(Number.MAX_SAFE_INTEGER)
    else if (cmd === 'log' && rest.length === 2 && rest[0] === '--since' && /^-?\d{1,15}$/.test(rest[1])) result = readLog(Number(rest[1]))
    else refuse('usage: add-suite <name> | remove-suite <name> | run <name> --env-root <dir> | list | log [--since <seq>]')
    log({ event: 'end', ...what, ...(cmd === 'run' ? { result } : {}) })
    return result
  } catch (error) {
    log({ event: 'end', ...what, error: error instanceof Refused ? error.message : 'failed' })
    throw error
  }
}

process.umask(0o077)
try {
  process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`)
} catch (error) {
  // A refusal says why; anything else is reported without detail, which could name suite content.
  process.stdout.write(`${JSON.stringify({ error: error instanceof Refused ? error.message : `the verifier failed (${error?.code ?? 'error'})` })}\n`)
  process.exitCode = 1
}
