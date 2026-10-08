/**
 * The L3 verifier on the CLI (docs/05 B1), keyless: `--gate-level` and
 * `--gate-suite` on the single path, `openswarm verifier`'s verbs and the
 * setup script it would run. The helper runs as the test's own user against
 * a temp store, injected in code (`injectVerifierForTests`: these tests run
 * the CLI in-process; production is always the installed sudo, and no
 * environment variable changes that), so the probe here shows detection, not
 * the kernel's denial: verifier.e2e.test.ts needs the real setup.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { injectVerifierForTests, verifierHelperSource, type RunHandle } from 'openswarm-swarm'
import { bootHarness, runCli, runControl } from '../src/index'
import { setupScript, uninstallScript, unsafePath } from '../src/verifier'

const root = process.getuid?.() === 0
let mock: MockLlmServer | undefined
const originalCwd = process.cwd()
afterEach(async () => {
  process.chdir(originalCwd)
  injectVerifierForTests(undefined)
  await mock?.close()
  mock = undefined
})

const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), `openswarm-verifier-cli-${prefix}-`))

/** A helper beside a temp store, injected as this process's verifier. */
function install(): { store: string; helper: string } {
  const dir = scratch('libexec')
  const store = join(scratch('store'), 'store')
  mkdirSync(store, { mode: 0o700 })
  const helper = join(dir, 'helper.mjs')
  copyFileSync(verifierHelperSource(), helper)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ store }))
  injectVerifierForTests({ command: [process.execPath, helper], user: '_openswarmverifier' })
  return { store, helper }
}

/** The `add` suite: node checks lib.mjs's `add` and reports through JUnit. */
function addSuite(): string {
  const dir = scratch('suite')
  writeFileSync(
    join(dir, 'check.mjs'),
    `import { add } from '../work/lib.mjs'\nimport { writeFileSync } from 'node:fs'\nconst ok = add(1, 2) === 3\nwriteFileSync('work/report.xml', '<testsuite><testcase name="adds"/>' + (ok ? '<testcase name="sums"/>' : '<testcase name="sums"><failure/></testcase>') + '</testsuite>')\n`,
  )
  writeFileSync(join(dir, 'openswarm-suite.json'), JSON.stringify({ command: 'cd {work}/.. && node suite/check.mjs', junit: 'report.xml' }))
  return dir
}

async function ctl(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runControl(argv, { out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

async function startMock(overrides: Parameters<typeof startMockLlmServer>[0]): Promise<void> {
  mock = await startMockLlmServer(overrides)
  process.env['OPENSWARM_LLM_BASE_URL'] = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'
}

function gitWorkspace(files: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), 'openswarm-run-ws-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: ws })
  git('init', '-q', '-b', 'main')
  for (const [path, text] of Object.entries(files)) writeFileSync(join(ws, path), text)
  git('add', '.')
  git('commit', '-qm', 'init')
  process.chdir(ws)
  return ws
}

async function run(...argv: string[]) {
  const lines: string[] = []
  const errs: string[] = []
  const code = await runCli(['run', '--output-format', 'json', '--model', 'mock-small', ...argv], { out: (l) => lines.push(l), err: (l) => errs.push(l) })
  return { code, lines, json: lines.map((l) => JSON.parse(l)), errs }
}

it('--gate-level and --gate-suite are checked before any spend', async () => {
  gitWorkspace({ 'a': '' })
  const error = async (...argv: string[]) => (await run(...argv, 'go')).json.find((o) => o.type === 'error')?.message
  expect(await error('--gate', '--gate-level', '3')).toMatch(/--gate-level 3 needs .* --gate-suite/)
  expect(await error('--gate', '--gate-level', '2')).toMatch(/--gate-level 2 needs checks/)
  expect(await error('--gate', '--gate-level', '4')).toMatch(/L4, external CI, is not built/)
  expect(await error('--gate', '--gate-suite', 'Bad Name')).toMatch(/suite name/)
  expect(await error('--gate-suite', 'add')).toMatch(/need --gate/)
  install()
  expect(await error('--gate', '--gate-suite', 'missing')).toMatch(/holds no suite "missing"/)
}, 60_000)

it.skipIf(root)('--gate --gate-suite: the hidden suite accepts at L3, the check gives feedback, and the agent hears only counts', async () => {
  install()
  expect((await ctl('verifier', 'add-suite', 'add', addSuite())).code).toBe(0)
  await startMock({
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'implemented',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: "echo 'export const add = (a, b) => a + b' > lib.mjs" }),
  })
  gitWorkspace({ 'lib.mjs': 'export const add = () => 0\n' })
  const r = await run('--gate', '--gate-level', '3', '--gate-suite', 'add', '--gate-check', 'test -f lib.mjs', 'implement add')
  expect(r.code).toBe(0)
  const rounds = r.json.filter((o) => o.type === 'gate_round' || o.type === 'gate')
  expect(rounds).toEqual([
    {
      type: 'gate_round',
      round: 1,
      changed: true,
      passed: true,
      kind: 'hidden',
      level: 3,
      score: null,
      rolledBack: false,
      suite: 'add',
      total: 2,
      failedTests: 0,
      enforcement: expect.stringMatching(/^(full|partial)$/),
      feedback: { kind: 'commands', level: 2, passed: true },
    },
    { type: 'gate', accepted: true, level: 3, rounds: 1 },
  ])
  expect(r.errs[0]).toMatch(/^gate: round 1 L3 hidden suite add — passed \(2 of 2 passing, enforcement (full|partial); feedback L2 checks — passed\)$/)
  expect(r.errs[1]).toBe('gate: accepted at L3 after 1 round')
}, 60_000)

it.skipIf(root)('the probe, keyless: an agent that reads the store and calls the helper is a tamper incident, reported by what matched', async () => {
  const { store, helper } = install()
  expect((await ctl('verifier', 'add-suite', 'add', addSuite())).code).toBe(0)
  await startMock({
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'looked around',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: `cat '${store}/suites/add/tests/check.mjs'; '${process.execPath}' '${helper}' list` }),
  })
  gitWorkspace({ 'lib.mjs': 'export const add = () => 0\n' })
  const r = await run('--gate', '--gate-suite', 'add', '--gate-check', 'true', 'implement add')
  expect(r.code).toBe(1)
  const tamper = r.json.find((o) => o.type === 'tamper')
  expect(tamper).toMatchObject({ round: 1, suite: 'add', severity: 'incident' })
  expect(new Set(tamper.signals.map((s: { signal: string; where: string }) => `${s.signal} in ${s.where}`))).toEqual(
    new Set(['store-path in transcript', 'helper-path in transcript', 'canary in transcript', 'helper-log in helper log']),
  )
  expect(r.json.find((o) => o.type === 'gate')).toEqual({ type: 'gate', accepted: false, level: 3, rounds: 1, reason: 'tamper' })
  expect(r.errs.at(-1)).toBe('gate: stopped — a tamper incident in round 1')
  // As the same user the read went through (the real setup is what denies
  // it); what this run reports never carries the canary or the source.
  expect(r.lines.join('\n')).not.toMatch(/openswarm-canary-[0-9a-f]{24}|add\(1, 2\)/)
}, 60_000)

it.skipIf(root)('a gated team at L3: a member reaching for the suite is journaled as swarm/tamper, asked of an owner, and abandons the task', async () => {
  const { store, helper } = install()
  expect((await ctl('verifier', 'add-suite', 'add', addSuite())).code).toBe(0)
  await startMock({
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'looked around',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: `ls '${store}/suites'; '${process.execPath}' '${helper}' list` }),
  })
  const ws = gitWorkspace({ 'lib.mjs': 'export const add = () => 0\n' })
  const harness = await bootHarness({
    routes: [{ route: 'openai', model: 'mock-small', adapter: 'openai', apiKeyEnv: 'OPENSWARM_LLM_API_KEY' }],
    workspace: ws,
    io: { out: () => {}, err: () => {} },
  })
  try {
    const spec = (suite: string) => ({
      topology: 'peer-team' as const,
      members: [{ name: 'm', agentOptions: { provider: 'openai', model: 'mock-small' } }],
      tasks: [{ subject: 'add', prompt: 'implement add' }],
      gate: { suite, minLevel: 3 as const, checks: ['true'] },
    })
    // The verifier is asked before anything is seeded or spent.
    await expect(harness.ctx.swarm.runTeam(spec('missing'), { parent: harness.lead.agent, confidenceCwd: ws })).rejects.toThrow(/holds no suite "missing"/)
    await expect(harness.ctx.swarm.runTeam({ ...spec('add'), gate: { minLevel: 3 } }, { parent: harness.lead.agent, confidenceCwd: ws })).rejects.toThrow(/needs L3, a hidden suite/)
    expect(mock!.requests).toHaveLength(0)

    const handle: RunHandle = await harness.ctx.swarm.start(spec('add'), { parent: harness.lead.agent, confidenceCwd: ws })
    await expect(handle.result).rejects.toThrow(/abandoned 1 task\(s\) — task-0: tamper incident in gate round 1/)
    const events = handle.journal.events
    const tamper = events.find((e) => e.type === 'swarm/tamper')?.data as { signals: { signal: string; where: string }[] }
    expect(new Set(tamper.signals.map((t) => `${t.signal} in ${t.where}`))).toEqual(
      new Set(['store-path in transcript', 'helper-path in transcript', 'helper-log in helper log']),
    )
    const question = events.filter((e) => e.type === 'swarm/question').map((e) => (e.data as { question: Record<string, unknown> }).question).at(-1)
    expect(question).toMatchObject({ trigger: 'tamper', kind: 'escalation', tier: 'high', status: 'defaulted', answer: 'abandon' })
    expect(events.find((e) => e.type === 'swarm/gate')?.data).toMatchObject({ kind: 'hidden', level: 3, passed: false, tamper: true })
  } finally {
    await harness.dispose()
  }
}, 60_000)

it.skipIf(root)('openswarm verifier add-suite, list and remove-suite go to the helper; list shows canary ids, not content', async () => {
  install()
  const added = await ctl('verifier', 'add-suite', 'add', addSuite())
  expect(added).toMatchObject({ code: 0 })
  expect(JSON.parse(added.out)).toEqual({ suite: 'add', files: 1, canaries: 1 })
  const listed = await ctl('verifier', 'list')
  expect(JSON.parse(listed.out).suites).toEqual([{ name: 'add', canaries: [expect.stringMatching(/^[0-9a-f]{16}$/)] }])
  expect(listed.out).not.toContain('add(1, 2)')
  expect((await ctl('verifier', 'add-suite', 'nope', scratch('empty'))).err).toMatch(/no openswarm-suite.json/)
  expect((await ctl('verifier', 'remove-suite', 'add')).code).toBe(0)
  expect(JSON.parse((await ctl('verifier', 'list')).out).suites).toEqual([])
  expect((await ctl('verifier', 'bogus')).code).toBe(2)
})

it('setup runs one script: a locked user, a 0700 store, node staged and checked root-only, a root-owned helper, sudoers validated before install', () => {
  const plan = { operator: 'alice', gid: 20, node: '/opt/node/bin/node', nodeHash: 'ab'.repeat(32), helperSource: '/pkg/verifier-helper.mjs', nologin: '/usr/sbin/nologin' }
  const mac = setupScript({ ...plan, platform: 'darwin', uid: 499 })
  for (const line of [
    '/usr/bin/dscl . -create /Users/_openswarmverifier UniqueID 499',
    '/usr/bin/dscl . -create /Users/_openswarmverifier UserShell /usr/bin/false',
    '/usr/bin/dscl . -create /Users/_openswarmverifier NFSHomeDirectory /var/empty',
    '/usr/bin/dscl . -create /Users/_openswarmverifier IsHidden 1',
    "/bin/chmod 0700 '/Library/Application Support/openswarm-verifier'",
    'stage=$(/usr/bin/mktemp -d /var/tmp/openswarm-verifier.XXXXXX)',
    `/usr/bin/install -o root -g wheel -m 0755 '/opt/node/bin/node' "$stage/node"`,
    `[ "$(/usr/bin/shasum -a 256 "$stage/node" | /usr/bin/cut -d' ' -f1)" = '${plan.nodeHash}' ]`,
    `/usr/bin/otool -L "$stage/node" | /usr/bin/tail -n +2`,
    'case "$lib" in /usr/lib/*|/System/Library/*) ;;',
    `/usr/bin/install -o root -g wheel -m 0755 "$stage/node" /usr/local/libexec/openswarm-verifier/bin/node`,
    "/usr/bin/install -o root -g wheel -m 0644 '/pkg/verifier-helper.mjs' /usr/local/libexec/openswarm-verifier/helper.mjs",
    '/usr/sbin/visudo -cf "$rules"',
    '/usr/bin/install -o root -g wheel -m 0440 "$rules" /etc/sudoers.d/openswarm-verifier',
  ]) {
    expect(mac).toContain(line)
  }
  // What is installed is what was checked: staged, hashed, its libraries listed, and only then promoted.
  const at = (text: string) => mac.indexOf(text)
  expect(at('"$stage/node"')).toBeLessThan(at('shasum'))
  expect(at('shasum')).toBeLessThan(at('otool'))
  expect(at('otool')).toBeLessThan(at('/usr/local/libexec/openswarm-verifier/bin/node'))
  // No tool is found on PATH: every command line starts with an absolute path, a builtin or shell syntax.
  for (const line of mac.split('\n').map((l) => l.trim())) {
    expect(line).toMatch(/^(#|\/|set |umask |if |fi$|stage=|trap |\[ |printf |rules=)/)
  }
  // The rules: running and reading without a password, changing suites with one, every time.
  expect(mac).toContain("'alice ALL=(_openswarmverifier) NOPASSWD: OPENSWARM_VERIFIER_RUN'")
  expect(mac).toContain("'alice ALL=(_openswarmverifier) PASSWD: OPENSWARM_VERIFIER_ADMIN'")
  expect(mac).toContain("'Defaults!OPENSWARM_VERIFIER_ADMIN timestamp_timeout=0'")
  expect(mac).toMatch(/OPENSWARM_VERIFIER_RUN = \S+openswarm-verifier run \*, \S+ list, \S+ log, \S+ log \*/)
  expect(mac).toMatch(/OPENSWARM_VERIFIER_ADMIN = \S+ add-suite \*, \S+ remove-suite \*/)
  // The helper runs its own node with a scrubbed environment, keeping only sudo's record of the caller.
  expect(mac).toContain('exec /usr/bin/env -i SUDO_UID="$SUDO_UID" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/local/libexec/openswarm-verifier/bin/node')
  expect(at('visudo -cf')).toBeLessThan(at('/etc/sudoers.d/openswarm-verifier'))
  execFileSync('/bin/sh', ['-n', '-c', mac])

  const linux = setupScript({ ...plan, platform: 'linux' })
  expect(linux).toContain('/usr/sbin/useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid 20 openswarm-verifier')
  expect(linux).toContain("/bin/chmod 0700 '/var/lib/openswarm-verifier'")
  expect(linux).toContain('/usr/bin/sha256sum "$stage/node"')
  expect(linux).toContain('/usr/bin/ldd "$stage/node"')
  expect(linux).toContain('case "$lib" in /lib/*|/lib64/*|/usr/lib/*|/usr/lib64/*) ;;')
  execFileSync('/bin/sh', ['-n', '-c', linux])

  const removal = uninstallScript('darwin')
  expect(removal.indexOf('/etc/sudoers.d/openswarm-verifier')).toBeLessThan(removal.indexOf('/usr/local/libexec/openswarm-verifier'))
})

it('the staged checks reject a node that changed or loads a library outside the system ones', () => {
  // The two checks from the script, run on a fake node (as this user: they use no root).
  const dir = scratch('stage')
  const node = join(dir, 'node')
  writeFileSync(node, 'not really node')
  const hash = execFileSync('/usr/bin/shasum', ['-a', '256', node], { encoding: 'utf8' }).split(' ')[0]!
  const script = setupScript({ platform: 'darwin', operator: 'a', gid: 20, uid: 499, node, nodeHash: hash, helperSource: '/x', nologin: '/x' })
  const hashCheck = script.split('\n').find((l) => l.startsWith('[ "$('))!
  const libCheck = script.split('\n').find((l) => l.includes('| while read -r lib'))!
  const sh = (line: string, stage: string) => spawnSync('/bin/sh', ['-c', `set -eu; stage=${stage}; ${line}`], { encoding: 'utf8' })
  expect(sh(hashCheck, dir).status).toBe(0)
  writeFileSync(node, 'swapped after the check')
  expect(sh(hashCheck, dir)).toMatchObject({ status: 1, stderr: expect.stringMatching(/node changed after it was checked/) })
  // The library check over a listing with a user-writable library in it.
  const listing = libCheck.replace(/^.*?\| while/, `printf '%s\\n' /usr/lib/libz.1.dylib /opt/homebrew/lib/libuv.1.dylib | while`)
  expect(sh(listing, dir)).toMatchObject({ status: 1, stderr: expect.stringMatching(/loads \/opt\/homebrew\/lib\/libuv\.1\.dylib, outside the system libraries/) })
  expect(sh(libCheck.replace(/^.*?\| while/, `printf '%s\\n' /usr/lib/libz.1.dylib /System/Library/Frameworks/X | while`), dir).status).toBe(0)
})

it('the install paths must be root-owned and writable by no one else, all the way up and where links lead', () => {
  const tree: Record<string, { uid: number; mode: number; link: boolean }> = {
    '/': { uid: 0, mode: 0o755, link: false },
    '/usr': { uid: 0, mode: 0o755, link: false },
    '/usr/local': { uid: 0, mode: 0o755, link: false },
    '/opt': { uid: 0, mode: 0o755, link: false },
    '/opt/homebrew': { uid: 501, mode: 0o755, link: false },
    '/opt/homebrew/lib': { uid: 501, mode: 0o755, link: false },
    '/srv': { uid: 0, mode: 0o775, link: false },
    '/lnk': { uid: 501, mode: 0o777, link: true },
  }
  const stat = (p: string) => tree[p]
  const same = (p: string) => p
  // A path not made yet is judged by its nearest ancestor.
  expect(unsafePath('/usr/local/libexec/openswarm-verifier', stat, same)).toBeUndefined()
  expect(unsafePath('/opt/homebrew/lib/libuv.dylib', stat, same)).toMatch(/\/opt\/homebrew\/lib is owned by uid 501, not root/)
  expect(unsafePath('/srv/x', stat, same)).toMatch(/\/srv is writable by its group or others/)
  // A link is judged by its directory, then where it leads.
  expect(unsafePath('/lnk', stat, same)).toBeUndefined()
  expect(unsafePath('/lnk', stat, () => '/opt/homebrew/lib')).toMatch(/owned by uid 501/)
})
