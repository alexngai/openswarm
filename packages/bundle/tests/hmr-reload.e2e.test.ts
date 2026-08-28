/**
 * Rung 6, live: a RUNNING harness picks up its own rebuilt `dist` — no restart.
 *
 * Env-gated (`OPENSWARM_HMR_E2E=1`) because it is genuinely invasive: it edits
 * a package's source in this working tree and runs `npm run build` twice. It
 * guards on a clean checkout first and restores in a `finally`, but a hard kill
 * mid-run can still leave the marker behind — `git checkout packages/` clears
 * it.
 *
 * What this pins, and why the cheap test cannot: `profile.e2e.test.ts` asserts
 * the hmr row is enabled and carries a cwd-derived `base`, but `--dump-config`
 * prints `!!js` expressions unevaluated, so it can only show that a base is
 * CONFIGURED. For a long time the row said `disabled: false` while the watcher
 * sat on the profile directory and saw nothing — enabled, silent, and useless.
 * Only a running harness distinguishes "configured" from "actually reloads".
 *
 * Deliberately runs WITHOUT `--expose-internals`. The loader reaches Node's
 * internals through `node-addon-require-builtin` instead, so the flag — and the
 * unstable-API and authored-code-reaching-the-module-loader risks that come
 * with it — is not needed. If someone later decides HMR requires the flag, this
 * test fails and that claim gets re-examined.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

const execFileAsync = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const launcher = resolve(repo, 'bin', 'openswarm.mjs')
const target = resolve(repo, 'packages', 'app-server', 'src', 'index.ts')
const enabled = process.env['OPENSWARM_HMR_E2E'] === '1' && existsSync(launcher)

let child: ChildProcess | undefined
let original: string | undefined

afterEach(async () => {
  // The launcher execs dsh as its OWN child, so signalling the launcher alone
  // leaves the harness holding the port. Spawned detached, so the negated pid
  // signals the whole process group.
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  child = undefined
  if (original !== undefined) {
    writeFileSync(target, original, 'utf8')
    original = undefined
    await execFileAsync('npm', ['run', 'build'], { cwd: repo }).catch(() => undefined)
  }
})

const git = async (...args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd: repo })).stdout

/** One JSON-RPC round trip: initialize, then read `swarm/runs`. */
async function probe(port: number): Promise<any> {
  const socket = connect({ host: '127.0.0.1', port })
  await new Promise<void>((res, rej) => {
    socket.once('connect', () => res())
    socket.once('error', rej)
  })
  const client = new JsonRpcLineTransport(socket, socket)
  client.start()
  try {
    await client.request('initialize', { cwd: repo, provider: 'openai', model: 'gpt-5.5' })
    return await client.request('swarm/runs', {})
  } finally {
    client.close()
    socket.destroy()
  }
}

async function waitForPort(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const socket = connect({ host: '127.0.0.1', port })
      await new Promise<void>((res, rej) => {
        socket.once('connect', () => res())
        socket.once('error', rej)
      })
      socket.destroy()
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`app-server never bound :${port}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/** Rebuild dist, then give the watcher time to see it and re-plug. */
async function rebuildAndSettle(): Promise<void> {
  await execFileAsync('npm', ['run', 'build'], { cwd: repo })
  await new Promise((r) => setTimeout(r, 8_000))
}

it.skipIf(!enabled)(
  'a running harness reloads its own rebuilt dist, same process, no --expose-internals',
  async () => {
    expect(
      (await git('status', '--porcelain')).trim(),
      'commit or stash before the HMR e2e — it edits this working tree',
    ).toBe('')

    const port = 4640
    original = readFileSync(target, 'utf8')

    child = spawn(process.execPath, [launcher, 'serve', '--port', String(port)], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: 'ignore',
      detached: true,
    })
    await waitForPort(port)

    // The flag must not be in play, or this proves the wrong thing. Inspect the
    // process actually BOUND to the port — the dsh harness the launcher
    // spawned — not the launcher, which is not the one running HMR.
    const { stdout: harnessPid } = await execFileAsync('lsof', [
      '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
    ])
    const pid = harnessPid.trim().split('\n')[0]!
    const { stdout: cmdline } = await execFileAsync('ps', ['-o', 'command=', '-p', pid])
    expect(cmdline, 'harness must run flag-free for this to prove anything').not.toContain(
      'expose-internals',
    )
    expect(process.env['NODE_OPTIONS'] ?? '').not.toContain('expose-internals')

    expect((await probe(port)).hmrProbe).toBeUndefined()

    // Edit the live source and rebuild the dist the running harness loaded.
    writeFileSync(
      target,
      original.replace(
        '        return {\n          runs: [...this.runs.values()]',
        "        return {\n          hmrProbe: 'reloaded',\n          runs: [...this.runs.values()]",
      ),
      'utf8',
    )
    await rebuildAndSettle()

    // Same process, new behaviour: the harness replaced its own code in place.
    expect(child.exitCode, 'process restarted instead of hot-reloading').toBeNull()
    expect((await probe(port)).hmrProbe).toBe('reloaded')
  },
  300_000,
)
