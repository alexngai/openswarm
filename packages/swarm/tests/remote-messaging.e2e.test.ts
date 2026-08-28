/**
 * Phase-4 end-to-end (docs/01): long-lived multi-turn subprocess members,
 * the lead's swarm socket, and cross-process peer messaging — all keyless
 * against the scriptable mock. Spawns are sequential and single-member
 * flows keep the shared mock's FIFO deterministic.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RemotePeer, SwarmServer, type PeerHandle } from '../src/index'
import { resolveMemberLaunch } from '../src/worktrees'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
let peers: RemotePeer[] = []
let server: SwarmServer | undefined
afterEach(async () => {
  for (const peer of peers) await peer.close().catch(() => undefined)
  peers = []
  await server?.close()
  server = undefined
  await h?.close()
  h = undefined
})

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-remote-e2e-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

function memberEnv(h: TestHarness, extra: Record<string, string> = {}): Record<string, string> {
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  return {
    OPENSWARM_LLM_BASE_URL: base,
    OPENSWARM_LLM_API_KEY: 'mock-key',
    DSH_MODEL: 'mock-model',
    ...extra,
  }
}

async function spawnRemote(
  h: TestHarness,
  name: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<RemotePeer> {
  const launch = resolveMemberLaunch()
  const peer = await RemotePeer.spawn({
    name,
    command: launch.command,
    args: launch.args,
    cwd,
    env: memberEnv(h, extraEnv),
    provider: 'openai',
    model: 'mock-model',
    briefing: `You are ${name}. Acknowledge.`,
  })
  peers.push(peer)
  return peer
}

it('a remote peer keeps one session across turns (multi-turn memory)', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'ok' })
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-remote-peer-'))
  const peer = await spawnRemote(h, 'solo', cwd)

  const first = await peer.ask([{ type: 'text', text: 'remember the codeword AZIMUTH' }])
  expect(first.stopReason).toBe('completed')
  await peer.ask([{ type: 'text', text: 'what was the codeword?' }])

  // The third request's history carries the briefing AND the first turn:
  // same session, real multi-turn memory across the process boundary.
  const lastBody = JSON.stringify(h.mock.requests.at(-1)?.body)
  expect(lastBody).toContain('You are solo. Acknowledge.')
  expect(lastBody).toContain('remember the codeword AZIMUTH')
  expect(lastBody).toContain('what was the codeword?')
  expect(h.mock.requests.length).toBe(3)
}, 60_000)

it('a member sends cross-process through the swarm socket; the target wakes', async () => {
  h = await bootHarness({
    // a-brief, b-brief, a-task (tool call), a-continuation, b-wakeup.
    sequence: ['success', 'success', 'tool_call_success', 'success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'swarm_send_message',
    toolArguments: JSON.stringify({ to: 'peer-b', message: 'walls are ready' }),
  })
  const roster = new Map<string, PeerHandle>()
  const mailbox = h.swarm.mailbox(h.lead.agent, roster)
  server = new SwarmServer(mailbox)
  await server.listen()

  const dirA = mkdtempSync(join(tmpdir(), 'openswarm-remote-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'openswarm-remote-b-'))
  const a = await spawnRemote(h, 'peer-a', dirA, {
    OPENSWARM_SWARM_URL: server.url,
    OPENSWARM_SWARM_TOKEN: server.addMember('peer-a'),
  })
  const b = await spawnRemote(h, 'peer-b', dirB, {
    OPENSWARM_SWARM_URL: server.url,
    OPENSWARM_SWARM_TOKEN: server.addMember('peer-b'),
  })
  roster.set('peer-a', { name: 'peer-a', remote: a })
  roster.set('peer-b', { name: 'peer-b', remote: b })

  const result = await a.ask([{ type: 'text', text: 'notify your teammate' }])
  expect(result.stopReason).toBe('completed')

  // Durable mailbox pair in the lead log; nothing pending.
  const leadEvents = (type: string) =>
    h!.lead.agent.session.events.filter((e: any) => e.type === type)
  expect(leadEvents('swarm/message/queued')).toHaveLength(1)
  expect(leadEvents('swarm/message/delivered')).toHaveLength(1)
  expect(mailbox.pending()).toHaveLength(0)

  // Peer-b's wakeup turn saw the framed message from peer-a.
  await b.ask([{ type: 'text', text: 'status?' }]) // serialize behind the wakeup turn
  const bodies = h.mock.requests.map((r) => JSON.stringify(r.body))
  const wake = bodies.find((body) => body.includes('walls are ready'))
  expect(wake).toBeDefined()
  expect(wake).toContain('Swarm message msg-')
  expect(wake).toContain('from peer-a')
}, 60_000)

it('remote messaging peer-team: member-keyed worktrees, multi-turn tasks, merged branches', async () => {
  const repo = scratchRepo()
  h = await bootHarness({
    // brief, task1 (bash + close), task2 (bash + close) — one member.
    sequence: ['success', 'tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({
      command: 'echo run-$(ls out-* 2>/dev/null | wc -l | tr -d " ") >> out-log.txt',
    }),
  })
  const result = await h.swarm.runTeam(
    {
      topology: 'peer-team',
      messaging: true,
      members: [{ name: 'solo' }],
      tasks: [
        { subject: 'one', prompt: 'do task one' },
        { subject: 'two', prompt: 'do task two', blockedBy: [0] },
      ],
    },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
    },
  )

  if (result.topology !== 'peer-team') throw new Error('wrong topology')
  for (const task of result.tasks) expect(task.status).toBe('completed')

  // One member-keyed branch, both task turns in ONE session and worktree.
  const git = result.git!
  expect(git.merged).toHaveLength(1)
  expect(git.merged[0]!.taskKey).toBe('solo')
  const log = execFileSync('git', ['show', `${git.targetBranch}:out-log.txt`], {
    cwd: repo,
  }).toString()
  expect(log).toBe('run-0\nrun-1\n')

  // Task-two's request history contains task one: multi-turn member memory.
  const lastBody = JSON.stringify(h.mock.requests.at(-1)?.body)
  expect(lastBody).toContain('do task one')
  expect(lastBody).toContain('do task two')
}, 120_000)

it('a member whose runtime dies mid-turn fails loud instead of hanging the team', async () => {
  // 'success' answers the briefing; 'stall' leaves the next turn open forever,
  // which is the window a crashing child would die in.
  h = await bootHarness({ sequence: ['success', 'stall'], repeatLast: true, successText: 'ok' })
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-remote-dead-'))
  const peer = await spawnRemote(h, 'doomed', cwd)

  const pending = peer.ask([{ type: 'text', text: 'this turn never completes' }])
  // Let the prompt reach the stalled endpoint so the turn is genuinely open.
  await new Promise((r) => setTimeout(r, 500))

  // The runtime goes away without us asking it to — a crash, not a teardown.
  await (peer as unknown as { client: { close(): Promise<void> } }).client.close()

  // Before the fix this awaited `turn/end` forever, and the team's own
  // teardown (which would have released it) sat behind this same await.
  await expect(pending).rejects.toThrow(/exited before its turn completed/)
}, 30_000)
