/**
 * Member sandbox (docs/05 A1): under `workspace-write` a member's bash and
 * editor write only its worktree and temp, and package caches move into temp
 * so installs leave the home directory alone. Real subprocess members against
 * the scripted mock; skipped where dsh cannot sandbox (no Seatbelt, bwrap or
 * Landlock).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import { afterEach, expect, it, vi } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

const plug = (m: unknown): any => (m as any).default ?? m

/** Why dsh cannot sandbox here: the provider the member mounts, confining `true` once. */
async function sandboxUnavailable(): Promise<string | undefined> {
  const ctx = new Context()
  ctx.plugin(plug(SandboxLocal))
  try {
    await new Promise<void>((resolve) => ctx.inject(['sandbox'], () => resolve()))
    const { argv } = ctx.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: tmpdir() })
    const run = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    return run.status === 0
      ? undefined
      : `sandbox runner failed: ${run.stderr || run.error?.message || `exit ${run.status}`}`
  } catch (error) {
    // SANDBOX_UNAVAILABLE: no usable backend on this host.
    return error instanceof Error ? error.message : String(error)
  } finally {
    await (ctx as any).fiber?.dispose?.()
  }
}

// Writes are probed here, outside the worktree AND temp: the scratch repos
// live under temp, which the sandbox leaves writable.
const outsideRoot = fileURLToPath(new URL('../../../node_modules/.cache/', import.meta.url))
mkdirSync(outsideRoot, { recursive: true })
const underTemp = [tmpdir(), '/tmp']
  .filter(existsSync)
  .map((p) => realpathSync(p))
  .some((t) => (realpathSync(outsideRoot) + sep).startsWith(t + sep))
const unavailable =
  (await sandboxUnavailable()) ??
  (underTemp ? 'this checkout is under temp, which the sandbox leaves writable' : undefined)

let h: TestHarness | undefined
const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await h?.close()
  h = undefined
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function outsideDir(): string {
  const dir = mkdtempSync(join(outsideRoot, 'openswarm-sandbox-'))
  cleanup.push(dir)
  return dir
}

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root })

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-sandbox-e2e-'))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

const show = (root: string, ref: string, file: string) => git(root, 'show', `${ref}:${file}`).toString()

function memberEnv(h: TestHarness): Record<string, string> {
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  return {
    OPENSWARM_LLM_BASE_URL: base,
    OPENSWARM_LLM_API_KEY: 'mock-key',
    DSH_MODEL: 'mock-model',
  }
}

it('bash writes land in the worktree; a write outside it and temp is refused', async ({ skip }) => {
  skip(unavailable !== undefined, unavailable)
  const repo = scratchRepo()
  const outside = outsideDir()
  h = await bootHarness({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'bash',
    toolArguments: JSON.stringify({
      command: `echo in > inside.txt; echo out > "${outside}/escape.txt"; echo $? > escape-exit.txt`,
    }),
  })

  // One-shot member (subagent-dsh-sdk), sandboxed by the per-run knob.
  const result = await h.swarm.runTeam(
    { topology: 'fanout', members: [{ name: 'solo' }], tasks: [{ member: 'solo', prompt: 'write' }] },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: memberEnv(h), sandbox: 'workspace-write' } },
    },
  )

  const target = result.git!.targetBranch
  expect(show(repo, target, 'inside.txt')).toBe('in\n')
  expect(show(repo, target, 'escape-exit.txt').trim()).not.toBe('0')
  expect(existsSync(join(outside, 'escape.txt'))).toBe(false)
}, 120_000)

it('the editor is refused outside the worktree', async ({ skip }) => {
  skip(unavailable !== undefined, unavailable)
  const repo = scratchRepo()
  const outside = outsideDir()
  h = await bootHarness({
    // Briefing, then the task: one editor call and a closing message.
    sequence: ['success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'str_replace_editor',
    toolArguments: JSON.stringify({ command: 'create', path: join(outside, 'edit.txt'), file_text: 'escaped\n' }),
  })

  // Long-lived member (RemotePeer), sandboxed by the per-run knob.
  await h.swarm.runTeam(
    {
      topology: 'peer-team',
      messaging: true,
      members: [{ name: 'solo' }],
      tasks: [{ subject: 'edit', prompt: 'edit' }],
    },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: memberEnv(h), sandbox: 'workspace-write' } },
    },
  )

  expect(existsSync(join(outside, 'edit.txt'))).toBe(false)
  expect(JSON.stringify(h.mock.requests.at(-1)?.body)).toContain(
    '[sandbox: file access denied under workspace-write mode]',
  )
}, 120_000)

it('npm install of a local dependency works with its cache in temp, not the home directory', async ({
  skip,
}) => {
  skip(unavailable !== undefined, unavailable)
  // The global default, not the knob.
  vi.stubEnv('OPENSWARM_MEMBER_SANDBOX', 'workspace-write')
  // `npm test` exports its own config (`npm_config_cache`, `npm_config_allow_scripts`,
  // …) to this process; the member's npm must start from a plain shell's.
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase().startsWith('npm_config_')) vi.stubEnv(key, undefined)
  }
  const repo = scratchRepo()
  // A local tarball: npm unpacks it through its cache, with no network.
  const dep = mkdtempSync(join(tmpdir(), 'openswarm-npm-dep-'))
  mkdirSync(join(dep, 'package'))
  writeFileSync(join(dep, 'package', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
  execFileSync('tar', ['czf', join(repo, 'dep-1.0.0.tgz'), '-C', dep, 'package'])
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'proj', version: '1.0.0', dependencies: { dep: 'file:./dep-1.0.0.tgz' } }),
  )
  git(repo, 'add', '-f', 'package.json', 'dep-1.0.0.tgz')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'dep')
  // Temp is writable to the member, so an unredirected cache would land here.
  const home = mkdtempSync(join(tmpdir(), 'openswarm-home-'))
  const outside = outsideDir()
  h = await bootHarness({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'bash',
    toolArguments: JSON.stringify({
      command:
        'npm install --offline --no-audit --no-fund > npm-out.txt 2>&1; echo $? > npm-exit.txt; ' +
        'npm config get cache > npm-cache.txt; node -p "require(\'dep/package.json\').version" > dep-version.txt; ' +
        `echo out > "${outside}/escape.txt"`,
    }),
  })

  const result = await h.swarm.runTeam(
    { topology: 'fanout', members: [{ name: 'solo' }], tasks: [{ member: 'solo', prompt: 'install' }] },
    { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { env: { ...memberEnv(h), HOME: home } } } },
  )

  const target = result.git!.targetBranch
  expect(show(repo, target, 'npm-exit.txt').trim(), show(repo, target, 'npm-out.txt')).toBe('0')
  expect(show(repo, target, 'dep-version.txt').trim()).toBe('1.0.0')
  expect(show(repo, target, 'npm-cache.txt').trim().startsWith(join(tmpdir(), 'openswarm-cache'))).toBe(true)
  expect(existsSync(join(home, '.npm'))).toBe(false)
  // The variable alone confined the member, through the spawner's env scrub.
  expect(existsSync(join(outside, 'escape.txt'))).toBe(false)
}, 120_000)
