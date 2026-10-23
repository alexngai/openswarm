/**
 * A respawned member resumes its own session (docs/05 A2).
 *
 * `RemotePeer` uses a stable session id (`swarm-member-<name>`) and the member
 * composition persists to `DSH_SESSION_ROOT`, so both halves of a resume are
 * on disk after a child exits. This pinned the gap while dsh's SDK server
 * always minted a new session; it now pins the fix: the member server
 * (`openswarm-swarm-member/server`) resumes a persisted session on a miss.
 *
 * Decided from the captured request history rather than the model's answer —
 * the mock returns canned text, so the only real evidence is whether the
 * second process sends the first process's turns back to the provider.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RemotePeer } from '../src/index'
import { resolveMemberLaunch } from '../src/worktrees'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
let peers: RemotePeer[] = []
afterEach(async () => {
  for (const peer of peers) await peer.close().catch(() => undefined)
  peers = []
  await h?.close()
  h = undefined
})

async function spawnAt(harness: TestHarness, name: string, cwd: string): Promise<RemotePeer> {
  const launch = resolveMemberLaunch()
  const base = harness.mock.baseURL.endsWith('/v1')
    ? harness.mock.baseURL
    : `${harness.mock.baseURL}/v1`
  const peer = await RemotePeer.spawn({
    name,
    command: launch.command,
    args: launch.args,
    cwd,
    env: {
      OPENSWARM_LLM_BASE_URL: base,
      OPENSWARM_LLM_API_KEY: 'mock-key',
      DSH_MODEL: 'mock-model',
      // Same cwd already implies the same default root; pin it so the probe
      // does not depend on that default.
      DSH_SESSION_ROOT: join(cwd, '.sessions'),
    },
    provider: 'openai',
    model: 'mock-model',
    briefing: `You are ${name}. Acknowledge.`,
  })
  peers.push(peer)
  return peer
}

it('a respawned member resumes its persisted session', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'ok' })
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-resume-probe-'))

  const first = await spawnAt(h, 'rememberer', cwd)
  await first.ask([{ type: 'text', text: 'remember the codeword AZIMUTH' }])
  await first.close()

  const before = h.mock.requests.length
  const second = await spawnAt(h, 'rememberer', cwd)
  await second.ask([{ type: 'text', text: 'what was the codeword?' }])

  const after = h.mock.requests.slice(before)
  const sawPriorTurn = after.some((r) => JSON.stringify(r.body).includes('AZIMUTH'))

  // Still one log, keyed by the stable session id: resume minted no new one.
  const root = join(cwd, '.sessions')
  const files = existsSync(root) ? readdirSync(root, { recursive: true } as never) as string[] : []
  const onDisk = files
    .map((f) => join(root, String(f)))
    .filter((f) => { try { return statSync(f).isFile() } catch { return false } })
  expect(onDisk).toHaveLength(1)
  expect(onDisk[0]).toContain('swarm-member-rememberer')
  expect(readFileSync(onDisk[0]!, 'utf8')).toContain('AZIMUTH')

  // ...and the fresh child sent the first child's turn back to the provider.
  expect(sawPriorTurn).toBe(true)
}, 60_000)
