/**
 * The L3 verifier (docs/05 B1), keyless: everything but the separate OS user.
 * The helper runs here as the test's own user against a temp store, through
 * a verifier injected in code (sudo in production; never the environment),
 * so these test its validation, its summary-only output and its confinement,
 * the tamper scan, verifier levels on the board, and the L3 gate. That the
 * kernel denies a member the store needs the real setup: verifier.e2e.test.ts
 * in packages/cli (OPENSWARM_VERIFIER_E2E=1).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SwarmBoard, evidenceText } from '../src/board'
import { runGate, type HiddenSuite, type HiddenSummary } from '../src/gate'
import { SwarmJournal } from '../src/journal'
import { recapJournal, type SwarmQuestionRequest } from '../src/run'
import { runPeerTeam, type RunMember } from '../src/topologies'
import type { MemberRunResult } from '../src/types'
import {
  canaryId,
  hiddenSuite,
  openVerifier,
  scanLog,
  scanText,
  scanTranscript,
  tarDirectory,
  activeVerifier,
  injectVerifierForTests,
  VERIFIER_INSTALL,
  tarEntry,
  verifierHelperSource,
  type ToolExchange,
  type Verifier,
  type VerifierLogEntry,
} from '../src/verifier'

const root = process.getuid?.() === 0
const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), `openswarm-verifier-${prefix}-`))

/** A helper installed as setup would, but owned by the test user, beside a temp store. */
function install(config: Record<string, unknown> = {}) {
  const dir = scratch('libexec')
  const store = join(scratch('store'), 'store')
  mkdirSync(store, { mode: 0o700 })
  const helper = join(dir, 'helper.mjs')
  copyFileSync(verifierHelperSource(), helper)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ store, ...config }))
  const verifier: Verifier = { command: [process.execPath, helper], user: '_openswarmverifier' }
  /** One helper call: exit status and its parsed line of JSON. */
  const call = (args: string[], input?: Buffer) => {
    const done = spawnSync(process.execPath, [helper, ...args], { input: input ?? Buffer.alloc(0) })
    return { status: done.status, out: JSON.parse(done.stdout.toString().trim()), raw: done.stdout.toString() }
  }
  return { store, helper, verifier, call }
}

/** A suite directory: its files and its manifest. */
function suiteDir(files: Record<string, string>, manifest: object): string {
  const dir = scratch('suite')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  writeFileSync(join(dir, 'openswarm-suite.json'), JSON.stringify(manifest))
  return dir
}

const tar = (...entries: Buffer[][]) => Buffer.concat([...entries.flat(), Buffer.alloc(1024)])
const manifestEntry = tarEntry('openswarm-suite.json', Buffer.from(JSON.stringify({ command: 'true' })))

function gitRepo(files: Record<string, string>): { repo: string; git: (...args: string[]) => string } {
  const repo = scratch('repo')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo }).toString()
  git('init', '-q', '-b', 'main')
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text)
  git('add', '.')
  git('commit', '-qm', 'init')
  return { repo, git }
}

const archive = (repo: string) => execFileSync('git', ['archive', 'HEAD'], { cwd: repo })

const reply = (member: string, text: string, runId = 'r'): MemberRunResult => ({ member, runId, text, output: [{ type: 'text', text }], stopReason: 'completed' })

/** The suite the L3 tests share: node checks lib.mjs's `add`, and reports through JUnit. */
const ADD_SUITE = {
  'check.mjs': `import { add } from '../work/lib.mjs'\nconst ok = add(1, 2) === 3\nconsole.log('SECRET TEST NAME: adds one and two')\nimport('node:fs').then(({ writeFileSync }) => writeFileSync('work/report.xml', '<testsuite><testcase name="adds"/>' + (ok ? '<testcase name="sums"/>' : '<testcase name="sums"><failure/></testcase>') + '</testsuite>'))\n`,
}
const ADD_MANIFEST = { command: 'cd {work}/.. && node suite/check.mjs', junit: 'report.xml' }

it.skipIf(root)('add-suite refuses bad names, paths that climb out or are absolute, links, devices, and a tar over the cap', () => {
  const v = install({ maxSuiteBytes: 8192 })
  const refused = (name: string, input: Buffer) => {
    const r = v.call(['add-suite', name], input)
    expect(r.status).toBe(1)
    return r.out.error as string
  }
  const ok = tar(manifestEntry, tarEntry('t.py', Buffer.from('x = 1\n')))
  expect(refused('Bad_Name', ok)).toMatch(/1-64 of \[a-z0-9-\]/)
  expect(refused('../up', ok)).toMatch(/1-64/)
  expect(refused('s', tar(manifestEntry, tarEntry('../escape.py', Buffer.from('x'))))).toMatch(/climbs out/)
  expect(refused('s', tar(manifestEntry, tarEntry('a/../../escape.py', Buffer.from('x'))))).toMatch(/climbs out/)
  expect(refused('s', tar(manifestEntry, tarEntry('/etc/passwd', Buffer.from('x'))))).toMatch(/absolute/)
  expect(refused('s', tar(manifestEntry, tarEntry('link.py', Buffer.alloc(0), 0o777, '2', '/etc/passwd')))).toMatch(/symlink/)
  expect(refused('s', tar(manifestEntry, tarEntry('hard.py', Buffer.alloc(0), 0o644, '1', 't.py')))).toMatch(/hard link/)
  expect(refused('s', tar(manifestEntry, tarEntry('dev', Buffer.alloc(0), 0o644, '3')))).toMatch(/device/)
  expect(refused('s', tar(manifestEntry, tarEntry('big.py', Buffer.alloc(9000))))).toMatch(/cap/)
  expect(refused('s', tar(tarEntry('t.py', Buffer.from('x'))))).toMatch(/no openswarm-suite.json/)
  expect(refused('s', tar(tarEntry('openswarm-suite.json', Buffer.from('{"command": ""}')), tarEntry('t.py', Buffer.from('x'))))).toMatch(/command/)
  // A corrupt header is refused, not guessed at.
  const corrupt = ok.subarray()
  corrupt[0] = corrupt[0]! ^ 1
  expect(refused('s', corrupt)).toMatch(/checksum/)
  // Nothing was stored by any of them.
  expect(readdirSync(join(v.store, 'suites'))).toEqual([])
})

it.skipIf(root)('add-suite stores the files read-only with a canary comment each; list gives names and canary ids, never content', () => {
  const v = install()
  const dir = suiteDir(
    { 'test_a.py': '#!/usr/bin/env python\nassert True', 'sub/b.test.ts': 'test("b", () => {})\n', 'data.json': '{"k": 1}' },
    { command: 'cd {work} && python -m pytest {suite}' },
  )
  expect(v.call(['add-suite', 'demo'], tarDirectory(dir))).toMatchObject({ status: 0, out: { suite: 'demo', files: 3, canaries: 2 } })
  const tests = join(v.store, 'suites', 'demo', 'tests')
  const py = readFileSync(join(tests, 'test_a.py'), 'utf8')
  const ts = readFileSync(join(tests, 'sub', 'b.test.ts'), 'utf8')
  // At the end, as a comment in each file's own syntax; the shebang still leads.
  expect(py).toMatch(/^#!\/usr\/bin\/env python\nassert True\n# openswarm-canary-[0-9a-f]{24}\n$/)
  expect(ts).toMatch(/^test\("b", \(\) => \{\}\)\n\/\/ openswarm-canary-[0-9a-f]{24}\n$/)
  // JSON takes no comment, so it gets none.
  expect(readFileSync(join(tests, 'data.json'), 'utf8')).toBe('{"k": 1}')
  // Read-only even to the verifier, and refused a second time.
  expect(() => writeFileSync(join(tests, 'test_a.py'), 'x')).toThrow()
  expect(v.call(['add-suite', 'demo'], tarDirectory(dir)).out.error).toMatch(/exists/)

  const canaries = [py, ts].map((text) => /openswarm-canary-[0-9a-f]{24}/.exec(text)![0])
  const listed = v.call(['list'])
  expect(listed.out).toEqual({
    store: v.store,
    enforcement: expect.stringMatching(/^(full|partial)$/),
    suites: [{ name: 'demo', canaries: expect.arrayContaining(canaries.map(canaryId)) }],
  })
  for (const canary of canaries) expect(listed.raw).not.toContain(canary)
  expect(listed.raw).not.toContain('assert True')

  expect(v.call(['remove-suite', 'demo'])).toMatchObject({ status: 0, out: { removed: 'demo' } })
  expect(v.call(['list']).out.suites).toEqual([])
})

it.skipIf(root)('run prints only a summary: counts from the JUnit report, never test names, output or source', () => {
  const v = install()
  expect(v.call(['add-suite', 'add'], tarDirectory(suiteDir(ADD_SUITE, ADD_MANIFEST))).status).toBe(0)
  const { repo, git } = gitRepo({ 'lib.mjs': 'export const add = (a, b) => a - b\n' })

  const failing = v.call(['run', 'add', '--env-root', repo], archive(repo))
  expect(failing.status).toBe(0)
  expect(Object.keys(failing.out).sort()).toEqual(['durationMs', 'enforcement', 'failed', 'passed', 'total'])
  expect(failing.out).toMatchObject({ passed: false, total: 2, failed: 1 })
  expect(failing.raw).not.toMatch(/SECRET|adds one|check\.mjs|sums/)
  expect(failing.raw.trim().split('\n')).toHaveLength(1)

  writeFileSync(join(repo, 'lib.mjs'), 'export const add = (a, b) => a + b\n')
  git('commit', '-qam', 'fix')
  expect(v.call(['run', 'add', '--env-root', repo], archive(repo)).out).toMatchObject({ passed: true, total: 2, failed: 0 })
  // Every run directory is gone afterwards.
  expect(readdirSync(join(v.store, 'runs'))).toEqual([])
})

it.skipIf(root)('run refuses a snapshot that would write through a link (a measured failure, with why), an --env-root inside the verifier, and an unknown suite', () => {
  const v = install()
  expect(v.call(['add-suite', 'add'], tarDirectory(suiteDir(ADD_SUITE, ADD_MANIFEST))).status).toBe(0)
  const outside = scratch('outside')
  // A link to a directory outside, then a file under the link's name: the file
  // lands in the work tree, and the link then fails, so nothing is written outside.
  const evil = tar(tarEntry('a', Buffer.alloc(0), 0o777, '2', outside), tarEntry('a/pwned', Buffer.from('x')))
  // The member's snapshot is at fault, not the verifier: a result, not an error.
  expect(v.call(['run', 'add', '--env-root', outside], evil)).toMatchObject({ status: 0, out: { passed: false, total: 0, refused: 'tar: EEXIST' } })
  expect(existsSync(join(outside, 'pwned'))).toBe(false)
  // Nor a link under a link: it would be made through the first, outside the work tree.
  const nested = tar(tarEntry('d', Buffer.alloc(0), 0o777, '2', outside), tarEntry('d/x', Buffer.alloc(0), 0o777, '2', '/etc'))
  expect(v.call(['run', 'add', '--env-root', outside], nested).out).toMatchObject({ passed: false, refused: 'tar: d/x is under the link d' })
  expect(readdirSync(outside)).toEqual([])
  expect(v.call(['run', 'add', '--env-root', v.store], archive(gitRepo({ 'x': '' }).repo)).out.error).toMatch(/inside the verifier/)
  expect(v.call(['run', 'add', '--env-root', 'relative'], Buffer.alloc(0)).out.error).toMatch(/absolute/)
  expect(v.call(['run', 'nope', '--env-root', outside], Buffer.alloc(0)).out.error).toMatch(/no suite "nope"/)
  expect(v.call(['run', 'add'], Buffer.alloc(0)).out.error).toMatch(/usage/)
  expect(readdirSync(join(v.store, 'runs'))).toEqual([])
})

it.skipIf(root)('where the platform confines fully, a run cannot read the store, write outside its directory, or reach the network', async () => {
  const v = install()
  // Another suite, and the log: neither is the run's to read.
  expect(v.call(['add-suite', 'other'], tarDirectory(suiteDir({ 'x.sh': 'echo hidden\n' }, { command: 'true' })))).toMatchObject({ status: 0 })
  const outside = join(scratch('outside'), 'leak')
  const server = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const probe = [
    `! cat '${join(v.store, 'suites', 'other', 'tests', 'x.sh')}'`,
    `! cat '${join(v.store, 'log.jsonl')}'`,
    `! touch '${outside}'`,
    `touch ./inside`,
    `node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(1)).on('error', () => process.exit(0))"`,
  ].join(' && ')
  expect(v.call(['add-suite', 'probe'], tarDirectory(suiteDir({ 'p.sh': '' }, { command: `cd {work} && ${probe}` }))).status).toBe(0)
  const { repo } = gitRepo({ 'x': '' })
  const result = await new Promise<{ out: any }>((resolve) => {
    const child = spawn(process.execPath, [v.helper, 'run', 'probe', '--env-root', repo])
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('close', () => resolve({ out: JSON.parse(out) }))
    child.stdin.end(archive(repo))
  })
  server.close()
  // macOS always has Seatbelt; a Linux host without bwrap reports partial, and there is nothing to assert.
  if (process.platform === 'darwin') expect(result.out.enforcement).toBe('full')
  if (result.out.enforcement !== 'full') return
  expect(result.out.passed).toBe(true)
  expect(existsSync(outside)).toBe(false)
})

it.skipIf(root)('the log records each call with its caller, and log --since returns only what came after', () => {
  const v = install()
  v.call(['list'])
  const { cursor, entries } = v.call(['log']).out
  expect(entries).toEqual([])
  v.call(['list'])
  v.call(['add-suite', 'BAD'], Buffer.alloc(0))
  const after = v.call(['log', '--since', String(cursor)]).out.entries as VerifierLogEntry[]
  expect(after.map((e) => [e.event, e.cmd, (e as any).error ?? ''])).toEqual([
    ['end', 'log', ''],
    ['start', 'list', ''],
    ['end', 'list', ''],
    ['start', 'add-suite', ''],
    ['end', 'add-suite', expect.stringMatching(/1-64/)],
    ['start', 'log', ''],
  ])
  for (const e of after) {
    expect(e.uid).toBe(process.getuid!())
    // Run directly here, so the caller is this test process.
    expect(e.ancestors[0]!.pid).toBe(process.pid)
  }
})

const patterns = { store: '/Library/Application Support/openswarm-verifier', helper: '/usr/local/libexec/openswarm-verifier/openswarm-verifier', user: '_openswarmverifier', canaries: [canaryId('openswarm-canary-0123456789abcdef01234567')] }

it('the scan: a name alone is advisory; a canary, sudo at the verifier, or a denied access by the member’s own command is an incident', () => {
  const brief = (signals: { signal: string; severity: string; match: string }[]) => signals.map((s) => [s.signal, s.severity, s.match])
  const text = (t: string) => brief(scanText(t, 'diff', patterns))
  // Names, as a repository that documents the verifier (OpenSwarm's own) has them: advisory.
  expect(text('ls -la /Library/Application\\ Support/openswarm-verifier')).toEqual([['store-path', 'advisory', patterns.store]])
  expect(text('+ helper: /usr/local/libexec/openswarm-verifier/openswarm-verifier, user _openswarmverifier')).toEqual([
    ['helper-path', 'advisory', patterns.helper],
    ['verifier-user', 'advisory', '_openswarmverifier'],
  ])
  // A canary exists only in a suite's files, recorded by its id; one from no suite is nothing.
  expect(text('x = 1\n# openswarm-canary-0123456789abcdef01234567')).toEqual([['canary', 'incident', `canary ${patterns.canaries[0]}`]])
  expect(text('# openswarm-canary-ffffffffffffffffffffffff\nnpm test\nverifier_user = x')).toEqual([])

  const transcript = (call: string, result = '') => brief(scanTranscript([{ call, result }], patterns))
  // The member's own command, denied by the kernel, or sudo aimed at the verifier: incidents.
  expect(transcript(`cat '${patterns.store}/suites/x/t.py'`, `cat: ${patterns.store}/suites/x/t.py: Permission denied`)).toEqual([
    ['store-path', 'advisory', patterns.store],
    ['permission-denied', 'incident', patterns.store],
  ])
  expect(transcript('sudo -n -u _openswarmverifier cat x', 'sudo: a password is required')).toEqual([
    ['verifier-user', 'advisory', '_openswarmverifier'],
    ['sudo', 'incident', 'sudo -u _openswarmverifier'],
  ])
  // The same words planted in a file a sibling reads stay advisory: the sibling's command named none of it.
  expect(
    transcript('cat NOTES.md', `run: sudo -u _openswarmverifier cat ${patterns.store}/suites/x\ncat: ${patterns.store}/suites/x: Permission denied`),
  ).toEqual([
    ['store-path', 'advisory', patterns.store],
    ['verifier-user', 'advisory', '_openswarmverifier'],
  ])
})

it("the log scan flags a helper call inside a member's turn by this process's descendants or an orphan, not the gate's own or a stranger's", () => {
  const entry = (pid: number, ancestors: number[], time = 50, cmd = 'list'): VerifierLogEntry => ({
    seq: 0,
    time,
    uid: 501,
    pid,
    ancestors: ancestors.map((p) => ({ pid: p, comm: p === 1 ? 'launchd' : 'bash' })),
    event: 'start',
    cmd,
  })
  const window = { from: 10, to: 100 }
  expect(scanLog([entry(90001, [90000, 777, process.pid])], window)).toEqual([
    { signal: 'helper-log', severity: 'incident', where: 'helper log', match: 'list by bash[90000] < bash[777] < bash[' + process.pid + ']' },
  ])
  expect(scanLog([entry(90002, [90000, 1])], window)).toHaveLength(1)
  // Another user's terminal: not descended from this process, not orphaned.
  expect(scanLog([entry(90003, [90000, 555, 444, 333, 1])], window)).toEqual([])
  // Outside the turn.
  expect(scanLog([entry(90004, [90000, process.pid], 5)], window)).toEqual([])
})

it('the gated board refuses evidence below the task’s verifier level; a human waiver has no level to fall short', async () => {
  const board = new SwarmBoard(SwarmJournal.open(join(scratch('j'), 'journal.jsonl')), { gated: true, minLevel: 3 })
  const claimed = async (input: { minLevel?: 0 | 1 | 2 | 3 } = {}) => {
    const t = await board.create({ subject: 's', prompt: 'p', ...input })
    return board.claim(t.id, 'm', t.revision)
  }
  const a = await claimed()
  await expect(board.complete(a.id, 'm', a.revision, 'r', { kind: 'commands', level: 2, passed: true, round: 1 })).rejects.toMatchObject({
    code: 'SWARM_TASK_UNVERIFIED',
    message: expect.stringMatching(/needs L3 evidence; this counts as L2/),
  })
  // Missing level is L0.
  await expect(board.complete(a.id, 'm', a.revision, 'r', { kind: 'review', passed: true, round: 1 })).rejects.toMatchObject({ code: 'SWARM_TASK_UNVERIFIED' })
  expect(await board.complete(a.id, 'm', a.revision, 'r', { kind: 'hidden', level: 3, passed: true, round: 1 })).toMatchObject({ status: 'completed' })
  const b = await claimed()
  expect(await board.complete(b.id, 'm', b.revision, 'r', { kind: 'human', passed: true, by: 'owner' })).toMatchObject({ status: 'completed' })
  // A task's own level replaces the team's.
  const c = await claimed({ minLevel: 1 })
  expect(await board.complete(c.id, 'm', c.revision, 'r', { kind: 'review', level: 1, passed: true, round: 1 })).toMatchObject({ status: 'completed' })
})

it('the gate refuses to start below its declared level', async () => {
  const { repo } = gitRepo({ 'a': '' })
  const run: RunMember = async (m) => reply(m.name, 'x')
  await expect(runGate({ task: 't', member: { name: 'm' }, commands: ['true'], minLevel: 3 }, { run, cwd: repo })).rejects.toThrow(/must reach L3, but its strongest source is L2/)
  await expect(runGate({ task: 't', member: { name: 'm' }, minLevel: 2 }, { run, cwd: repo, review: async () => reply('r', '') })).rejects.toThrow(/L2 needs checks/)
})

/** The L3 source for `repo` on a fresh helper holding the add suite, and the session behind it. */
async function l3(repo: string, transcript: () => ToolExchange[] = () => []) {
  const v = install()
  expect(v.call(['add-suite', 'add'], tarDirectory(suiteDir(ADD_SUITE, ADD_MANIFEST))).status).toBe(0)
  const session = await openVerifier(v.verifier, ['add'])
  const hidden = hiddenSuite(session, { suite: 'add', cwd: async () => repo, envRoot: repo, transcript })
  return { v, session, hidden }
}

it.skipIf(root)('L3: the hidden suite accepts, the checks only give feedback, and the member is told counts and nothing else', async () => {
  const { repo } = gitRepo({ 'lib.mjs': 'export const add = () => 0\n' })
  const { v, hidden } = await l3(repo)
  await expect(openVerifier(v.verifier, ['add', 'missing'])).rejects.toThrow(/no suite "missing"/)
  const prompts: string[] = []
  const run: RunMember = async (m, prompt) => {
    prompts.push(prompt)
    writeFileSync(join(repo, 'lib.mjs'), prompts.length === 1 ? 'export const add = (a, b) => a - b\n' : 'export const add = (a, b) => a + b\n')
    return reply(m.name, 'done')
  }
  // The check passes from round 1, so only the hidden suite holds the task back.
  const result = await runGate({ task: 'implement add', member: { name: 'm' }, commands: ['test -f lib.mjs'], minLevel: 3 }, { run, cwd: repo, hidden })
  expect(result).toMatchObject({ accepted: true, level: 3 })
  expect(result.rounds.map((r) => [r.evidence.kind, r.evidence.level, r.evidence.passed, r.evidence.total, r.evidence.failed, r.feedback?.kind, r.feedback?.passed])).toEqual([
    ['hidden', 3, false, 2, 1, 'commands', true],
    ['hidden', 3, true, 2, 0, 'commands', true],
  ])
  expect(prompts[1]).toContain('A hidden acceptance suite, which you cannot see, then ran on the result')
  expect(prompts[1]).toContain('hidden acceptance suite: 1 of 2 failing')
  // Counts, and nothing of the suite: no names, no output, no source, no canary.
  expect(prompts[1]).not.toMatch(/SECRET|adds|sums|check\.mjs|openswarm-canary/)
})

it.skipIf(root)('L3: a member that reaches for the suite in its turn is a tamper incident: nothing is measured and the gate stops', async () => {
  const { repo } = gitRepo({ 'lib.mjs': 'export const add = (a, b) => a + b\n' })
  let transcript: ToolExchange[] = []
  const { v, session, hidden } = await l3(repo, () => transcript)
  const stored = readFileSync(join(v.store, 'suites', 'add', 'tests', 'check.mjs'), 'utf8')
  const run: RunMember = async (m) => {
    // What a member's shell would do, as the same user here: list the
    // verifier's suites, read a suite file, try sudo.
    execFileSync(process.execPath, [v.helper, 'list'])
    transcript = [
      { call: `cat '${session.store}/suites/add/tests/check.mjs'`, result: stored },
      { call: 'sudo -u _openswarmverifier true', result: '' },
    ]
    return reply(m.name, 'done')
  }
  const result = await runGate({ task: 'implement add', member: { name: 'm' } }, { run, cwd: repo, hidden })
  expect(result).toMatchObject({ accepted: false, reason: 'tamper', level: 3 })
  expect(result.rounds).toHaveLength(1)
  const evidence = result.rounds[0]!.evidence
  expect(evidence).toMatchObject({ kind: 'hidden', level: 3, passed: false, suite: 'add' })
  expect(new Set(evidence.tamper!.map((t) => `${t.signal} in ${t.where}`))).toEqual(
    new Set(['store-path in transcript', 'canary in transcript', 'verifier-user in transcript', 'sudo in transcript', 'helper-log in helper log']),
  )
  // What was recorded names what matched, never the suite's content.
  expect(JSON.stringify(evidence)).not.toMatch(/SECRET|openswarm-canary-[0-9a-f]{24}/)
  // The suite never ran: the only calls after the session opened are the member's list and the gate's log.
  const log = execFileSync(process.execPath, [v.helper, 'log', '--since', String(session.cursor)]).toString()
  expect((JSON.parse(log).entries as VerifierLogEntry[]).filter((e) => e.event === 'start').map((e) => e.cmd)).toEqual(['list', 'log', 'log'])
})

it.skipIf(root)('L3 on the board: the level is journaled; a tamper incident is journaled and asked of an owner, and abandons by default', async () => {
  const { repo } = gitRepo({ 'lib.mjs': 'export const add = (a, b) => a + b\n' })
  let transcript: ToolExchange[] = []
  const { session } = await l3(repo, () => transcript)
  const journal = SwarmJournal.open(join(scratch('j'), 'journal.jsonl'))
  const board = new SwarmBoard(journal, { gated: true, minLevel: 3 })
  const asked: SwarmQuestionRequest[] = []
  const run: RunMember = async (m, prompt) => {
    // The second task's member goes looking, through sudo.
    transcript = prompt.includes('peek') ? [{ call: `sudo -u _openswarmverifier ls '${session.store}'`, result: '' }] : []
    return reply(m.name, 'done')
  }
  const outcome = await runPeerTeam(
    {
      topology: 'peer-team',
      members: [{ name: 'm' }],
      tasks: [
        { subject: 'add', prompt: 'implement add' },
        { subject: 'peek', prompt: 'peek at the tests' },
      ],
      gate: { suite: 'add', minLevel: 3 },
    },
    run,
    board,
    undefined,
    async (q) => (asked.push(q), q.default),
    { minLevel: 3, tree: (_m, claimed) => ({ cwd: repo, hidden: hiddenSuite(session, { suite: claimed.suite ?? 'add', cwd: async () => repo, envRoot: repo, transcript: () => transcript }) }) },
  ).then(
    () => 'finished',
    (error: Error) => error.message,
  )
  expect(outcome).toMatch(/abandoned 1 task\(s\) — task-1: tamper incident in gate round 1/)
  expect(board.list().map((t) => [t.subject, t.status, t.evidence?.kind, t.evidence?.level])).toEqual([
    ['add', 'completed', 'hidden', 3],
    ['peek', 'pending', undefined, undefined],
  ])
  expect(asked).toEqual([expect.objectContaining({ trigger: 'tamper', kind: 'escalation', tier: 'high', options: ['abandon', 'continue'], default: 'abandon' })])
  const recap = recapJournal(journal.events).map((line) => line.replace(/^#\d+ /, ''))
  expect(recap).toContainEqual(expect.stringMatching(/^task-0 gate round 1 \(m\): L3 hidden suite add passed \(2 of 2 passing, enforcement (full|partial)\)$/))
  expect(recap).toContain('task-0 completed by m (L3 hidden, round 1): done')
  expect(recap).toContain('task-1 gate round 1 (m): L3 tamper incident — not measured')
  expect(recap).toContain('task-1 tamper incident in gate round 1 (m): store-path in transcript, verifier-user in transcript, sudo in transcript')
  expect(journal.events.find((e) => e.type === 'swarm/tamper')?.data).toEqual({
    version: 1,
    taskId: 'task-1',
    member: 'm',
    round: 1,
    suite: 'add',
    severity: 'incident',
    signals: [
      { signal: 'store-path', severity: 'advisory', where: 'transcript', match: session.store },
      { signal: 'verifier-user', severity: 'advisory', where: 'transcript', match: '_openswarmverifier' },
      { signal: 'sudo', severity: 'incident', where: 'transcript', match: 'sudo -u _openswarmverifier' },
    ],
  })
})

it.skipIf(root)('advisory signs are journaled and the round measured: a repository that names the verifier can be gated, and text a sibling planted abandons nothing', async () => {
  const { repo } = gitRepo({ 'lib.mjs': 'export const add = (a, b) => a + b\n', 'NOTES.md': '' })
  let transcript: ToolExchange[] = []
  const { session } = await l3(repo, () => transcript)
  const journal = SwarmJournal.open(join(scratch('j'), 'journal.jsonl'))
  const board = new SwarmBoard(journal, { gated: true, minLevel: 3 })
  const asked: SwarmQuestionRequest[] = []
  const run: RunMember = async (m, prompt) => {
    if (prompt.includes('document')) {
      // OpenSwarm's own docs name the verifier's paths and user.
      writeFileSync(join(repo, 'NOTES.md'), `The store is ${session.store}; the helper is ${session.verifier.command.at(-1)}; the user is _openswarmverifier.\n`)
      transcript = []
    } else {
      // What a sibling planted, read by a member that never aimed at the verifier itself.
      transcript = [{ call: 'cat NOTES.md', result: `sudo -u _openswarmverifier cat '${session.store}/suites/add'\ncat: ${session.store}/suites/add: Permission denied` }]
    }
    return reply(m.name, 'done')
  }
  await runPeerTeam(
    {
      topology: 'peer-team',
      members: [{ name: 'm' }],
      tasks: [
        { subject: 'docs', prompt: 'document the verifier' },
        { subject: 'read', prompt: 'read the notes' },
      ],
      gate: { suite: 'add', minLevel: 3 },
    },
    run,
    board,
    undefined,
    async (q) => (asked.push(q), q.default),
    { minLevel: 3, tree: () => ({ cwd: repo, hidden: hiddenSuite(session, { suite: 'add', cwd: async () => repo, envRoot: repo, transcript: () => transcript }) }) },
  )
  // Both measured and accepted at L3; nobody was asked anything.
  expect(board.list().map((t) => [t.subject, t.status, t.evidence?.level])).toEqual([
    ['docs', 'completed', 3],
    ['read', 'completed', 3],
  ])
  expect(asked).toEqual([])
  const tampers = journal.events.filter((e) => e.type === 'swarm/tamper').map((e) => e.data as { taskId: string; severity: string; signals: { severity: string }[] })
  expect(tampers.map((t) => [t.taskId, t.severity, t.signals.every((s) => s.severity === 'advisory')])).toEqual([
    ['task-0', 'advisory', true],
    ['task-1', 'advisory', true],
  ])
  expect(recapJournal(journal.events).map((line) => line.replace(/^#\d+ /, ''))).toContain(
    'task-0 tamper advisory in gate round 1 (m): store-path in diff, helper-path in diff, verifier-user in diff',
  )
})

const VERIFIER = '/usr/local/libexec/openswarm-verifier/openswarm-verifier'

/** An L3 source that answers each round from `summaries`, and scans clean. */
function scripted(summaries: Partial<HiddenSummary>[], allowPartial = false): HiddenSuite {
  return {
    suite: 'add',
    allowPartial,
    run: async () => ({ passed: false, total: 1, failed: 1, durationMs: 1, enforcement: 'full', ...summaries.shift() }),
    scan: async () => [],
  }
}

it('a run the verifier could not fully confine is not L3: it ends the gate, unless allowed, and then a board counts it as L2', async () => {
  const { repo } = gitRepo({ 'a': '' })
  let edits = 0
  const run: RunMember = async (m) => {
    writeFileSync(join(repo, 'a'), String(++edits))
    return reply(m.name, 'done')
  }
  const refused = await runGate({ task: 't', member: { name: 'm' } }, { run, cwd: repo, hidden: scripted([{ passed: true, total: 1, failed: 0, enforcement: 'partial' }]) })
  expect(refused).toMatchObject({ accepted: false, reason: 'hidden suite unconfined', level: 3 })
  expect(refused.rounds[0]!.evidence).toEqual({ kind: 'hidden', level: 3, passed: false, suite: 'add', enforcement: 'partial' })

  const allowed = await runGate({ task: 't', member: { name: 'm' } }, { run, cwd: repo, hidden: scripted([{ passed: true, total: 1, failed: 0, enforcement: 'partial' }], true) })
  expect(allowed).toMatchObject({ accepted: true, level: 3 })
  const e = allowed.rounds[0]!.evidence
  expect(e).toMatchObject({ kind: 'hidden', level: 3, passed: true, enforcement: 'partial' })

  const evidence = { kind: 'hidden', level: 3, passed: true, round: 1, enforcement: 'partial' } as const
  expect(evidenceText(evidence)).toBe('L3 hidden (partial: counts as L2), round 1')
  const board = new SwarmBoard(SwarmJournal.open(join(scratch('j'), 'journal.jsonl')), { gated: true, minLevel: 3 })
  const at = async (minLevel: 2 | 3) => {
    const t = await board.create({ subject: 's', prompt: 'p', minLevel })
    return board.claim(t.id, 'm', t.revision)
  }
  const three = await at(3)
  await expect(board.complete(three.id, 'm', three.revision, 'r', evidence)).rejects.toThrow(/needs L3 evidence; this counts as L2/)
  const two = await at(2)
  expect(await board.complete(two.id, 'm', two.revision, 'r', evidence)).toMatchObject({ status: 'completed' })
})

it('a snapshot the verifier refuses is a measured failure of the round, and the member is told why', async () => {
  const { repo } = gitRepo({ 'a': '' })
  const prompts: string[] = []
  const run: RunMember = async (m, prompt) => {
    prompts.push(prompt)
    writeFileSync(join(repo, 'a'), String(prompts.length))
    return reply(m.name, 'done')
  }
  const hidden = scripted([{ passed: false, total: 0, failed: 0, refused: 'tar: x is under the link y' }, { passed: true, total: 1, failed: 0 }])
  const result = await runGate({ task: 't', member: { name: 'm' } }, { run, cwd: repo, hidden })
  expect(result).toMatchObject({ accepted: true, level: 3 })
  expect(result.rounds[0]!.evidence).toMatchObject({ kind: 'hidden', passed: false, refused: 'tar: x is under the link y' })
  expect(prompts[1]).toContain('hidden suite: snapshot refused: tar: x is under the link y')
})

it('no environment variable changes the verifier: only code injects one, and a host that cannot confine is refused unless allowed', async () => {
  const installed = ['/usr/bin/sudo', '-n', '-u', VERIFIER_INSTALL.user, VERIFIER_INSTALL.helper]
  // What the env-based override used to read, set together, changes nothing.
  process.env['OPENSWARM_VERIFIER_COMMAND'] = JSON.stringify([process.execPath, '/tmp/fake-helper.mjs'])
  process.env['OPENSWARM_VERIFIER_TEST'] = '1'
  try {
    expect(activeVerifier()).toEqual({ command: installed, user: VERIFIER_INSTALL.user })
  } finally {
    delete process.env['OPENSWARM_VERIFIER_COMMAND']
    delete process.env['OPENSWARM_VERIFIER_TEST']
  }
  // Code can, for this process: what the in-process tests do.
  const fake = { command: [process.execPath, '-e', `console.log(JSON.stringify(process.argv.includes('log') ? { cursor: 4, entries: [] } : { store: '/s', enforcement: 'partial', suites: [{ name: 'add', canaries: [] }] }))`], user: 'u' }
  injectVerifierForTests(fake)
  try {
    expect(activeVerifier()).toBe(fake)
  } finally {
    injectVerifierForTests(undefined)
  }
  expect(activeVerifier().command).toEqual(installed)

  // A helper on a host that can only partly confine (scripted here).
  await expect(openVerifier(fake, ['add'], {})).rejects.toThrow(/cannot fully confine.*OPENSWARM_VERIFIER_ALLOW_PARTIAL=1/)
  expect(await openVerifier(fake, ['add'], { OPENSWARM_VERIFIER_ALLOW_PARTIAL: '1' })).toMatchObject({ allowPartial: true, cursor: 4 })
})
