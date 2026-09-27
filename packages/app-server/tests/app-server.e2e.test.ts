/**
 * App-server E2E, keyless: raw JSON-RPC clients over TCP exercise the socket
 * carrier — token auth and the protocol's policy — and both halves of the
 * surface behind it: the delegated dsh SDK protocol (initialize handshake,
 * streamed session events) and the swarm protocol (start → runFinished
 * notification, runs, view, events, cancel, token).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'
import AppServer from '../src/index'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'

let h: TestHarness | undefined
const sockets: Socket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await (h as any)?.ctx?.swarmAppServer?.close()
  await h?.close()
  h = undefined
})

const tokenFile = () => join(process.env['OPENSWARM_HOME']!, 'app-server.json')
/** The owner token the server wrote for the CLI. */
const ownerToken = (): string => JSON.parse(readFileSync(tokenFile(), 'utf8')).token

const route = { provider: 'deepseek-official', model: 'mock-model' }
const fanout = {
  topology: 'fanout',
  members: [{ name: 'a' }, { name: 'b' }],
  tasks: [
    { member: 'a', prompt: 'first' },
    { member: 'b', prompt: 'second' },
  ],
}

/** Resolve once the mounted app-server listens (and its token file exists). */
async function listening(ctx: any): Promise<void> {
  await new Promise<void>((resolve) => ctx.inject(['swarmAppServer'], () => resolve()))
  await ctx.swarmAppServer.ready
}

/** Boot a harness on the scripted mock and mount the app-server. */
async function serve(mock: MockLlmServerOptions): Promise<any> {
  h = await bootHarness(mock)
  const ctx = (h as any).ctx
  ctx.plugin(AppServer, {})
  await listening(ctx)
  return ctx
}

interface Client {
  request(method: string, params?: object): Promise<any>
  notifications: { method: string; params: any }[]
}

/** A raw client on the listening app-server, authenticated when given a token. */
async function connectClient(ctx: any, token?: string): Promise<Client> {
  const [host, port] = ctx.swarmAppServer.url.split(':')
  const socket = connect({ host, port: Number(port) })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const transport = new JsonRpcLineTransport(socket, socket)
  const notifications: Client['notifications'] = []
  transport.onNotification((method, params) => notifications.push({ method, params }))
  transport.start()
  const client: Client = {
    request: (method, params = {}) => transport.request(method, params as never),
    notifications,
  }
  if (token !== undefined) await client.request('swarm/auth', { token })
  return client
}

/** The `swarm.runFinished` notification for `runId`. */
const runFinished = (client: Client, runId: string) =>
  vi.waitFor(
    () => {
      const n = client.notifications.find((x) => x.method === 'swarm.runFinished' && x.params.runId === runId)
      if (n === undefined) throw new Error('runFinished never arrived')
      return n.params
    },
    { timeout: 20_000, interval: 25 },
  )

it('serves the delegated SDK protocol and the swarm protocol to the owner', async () => {
  const ctx = await serve({ sequence: ['success'], repeatLast: true, successText: 'wire-answer' })
  const client = await connectClient(ctx)
  // The CLI's credential: the owner token beside the URL, readable by this user only.
  expect(JSON.parse(readFileSync(tokenFile(), 'utf8'))).toEqual({
    url: ctx.swarmAppServer.url,
    token: expect.any(String),
    pid: process.pid,
  })
  expect(statSync(tokenFile()).mode & 0o777).toBe(0o600)
  expect(await client.request('swarm/auth', { token: ownerToken() })).toEqual({ principal: { role: 'owner' } })

  // Delegated half: the dsh SDK handshake answers with its wire identity.
  const init = await client.request('initialize', { cwd: process.cwd(), ...route })
  expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

  // Swarm half: run a fanout team; completion arrives as a notification.
  const { runId } = await client.request('swarm/start', { ...route, spec: fanout })
  expect(runId).toMatch(/^run-/)
  const finished = await runFinished(client, runId)
  expect(finished.result.topology).toBe('fanout')
  expect(finished.result.results).toHaveLength(2)
  expect(finished.result.results[0].text).toContain('wire-answer')

  // The delegated event stream flowed: member session events reached the wire.
  expect(client.notifications.some((n) => n.method === 'session.event')).toBe(true)

  // Run registry reflects completion.
  expect((await client.request('swarm/runs')).runs).toEqual([
    expect.objectContaining({
      id: runId,
      status: 'finished',
      topology: 'fanout',
      parentSessionId: expect.stringContaining('swarm-app-'),
    }),
  ])

  // Unknown swarm methods reject cleanly.
  await expect(client.request('swarm/nope')).rejects.toThrow('UNKNOWN_METHOD: unknown swarm method: swarm/nope')

  // Closing revokes the owner token and removes its file.
  await ctx.swarmAppServer.close()
  expect(existsSync(tokenFile())).toBe(false)
}, 30_000)

it('a run is viewable per run, across an app-server restart', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const ctx = (h as any).ctx
  const server = ctx.plugin(AppServer, {})
  await listening(ctx)
  const client = await connectClient(ctx, ownerToken())
  const { runId } = await client.request('swarm/start', {
    ...route,
    spec: { topology: 'peer-team', members: [{ name: 'solo' }], tasks: [{ subject: 'one', prompt: 'do one' }] },
  })
  const done = await runFinished(client, runId)
  expect(done.error, JSON.stringify(done)).toBeUndefined()

  // The per-run lead is disposed once the run settles (no unbounded lead
  // accumulation on a long-lived server)...
  const runs = await client.request('swarm/runs')
  const leadId = runs.runs.find((r: any) => r.id === runId)!.parentSessionId
  expect(ctx.agents.get(leadId)).toBeUndefined()

  // ...yet swarm/view still answers, from the run's journal.
  const view = await client.request('swarm/view', { runId })
  expect(view.run).toMatchObject({ id: runId, status: 'finished' })
  expect(view.tasks).toHaveLength(1)
  expect(view.tasks[0]).toMatchObject({ subject: 'one', status: 'completed', owner: 'solo' })

  // A fresh app-server over the same runs directory still lists the run and
  // serves its view: the run table is the journals, not server memory. It
  // writes a fresh owner token.
  await server.dispose()
  ctx.plugin(AppServer, {})
  await listening(ctx)
  const after = await connectClient(ctx, ownerToken())
  expect((await after.request('swarm/runs')).runs.map((r: any) => [r.id, r.status])).toEqual([[runId, 'finished']])
  expect(await after.request('swarm/view', { runId })).toEqual(view)
}, 30_000)

it('refuses everything before auth, and each principal beyond its policy', async () => {
  const ctx = await serve({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const handshake = { cwd: process.cwd(), ...route }

  // Unauthenticated: a swarm method and the SDK pass-through are both refused.
  const anonymous = await connectClient(ctx)
  await expect(anonymous.request('swarm/runs')).rejects.toThrow(/^FORBIDDEN: authenticate with swarm\/auth/)
  await expect(anonymous.request('initialize', handshake)).rejects.toThrow(/^FORBIDDEN: authenticate with swarm\/auth/)
  await expect(anonymous.request('swarm/auth', { token: 'guessed' })).rejects.toThrow('FORBIDDEN: unknown token')

  const owner = await connectClient(ctx, ownerToken())
  const mint = async (params: object): Promise<string> => (await owner.request('swarm/token', params)).token
  const viewer = await connectClient(ctx, await mint({ role: 'viewer' }))
  const { runId } = await owner.request('swarm/start', { ...route, spec: fanout })
  await runFinished(owner, runId)
  // dsh's SDK server streams every session in the process, so only the owner's connection has one.
  expect(owner.notifications.some((n) => n.method === 'session.event')).toBe(true)
  expect([...anonymous.notifications, ...viewer.notifications]).toEqual([])

  // A viewer reads state and nothing else.
  expect((await viewer.request('swarm/runs')).runs.map((r: any) => r.id)).toEqual([runId])
  expect((await viewer.request('swarm/view', { runId })).run.status).toBe('finished')
  const direction: [string, object][] = [
    ['swarm/start', { ...route, spec: fanout }],
    ['swarm/steer', { runId, to: 'a', text: 'hi' }],
    ['swarm/cancel', { runId }],
  ]
  for (const [method, params] of direction) {
    await expect(viewer.request(method, params)).rejects.toThrow(`FORBIDDEN: viewer may not call ${method}`)
  }
  // Nor answers a question, which neither a viewer nor a member may (docs/05 §7.3 exit criterion 4).
  const answer = { runId, questionId: 'q-0', answer: 'drop' }
  await expect(viewer.request('swarm/answer', answer)).rejects.toThrow('FORBIDDEN: viewer may not call swarm/answer')
  await expect(viewer.request('initialize', handshake)).rejects.toThrow('FORBIDDEN: viewer may not call initialize')

  const member = await connectClient(ctx, await mint({ role: 'member', runId, member: 'a' }))
  await expect(member.request('swarm/steer', { runId, to: 'b', text: 'hi' })).rejects.toThrow(
    'FORBIDDEN: member may not call swarm/steer',
  )
  await expect(member.request('swarm/answer', answer)).rejects.toThrow('FORBIDDEN: member may not call swarm/answer')

  const driver = await connectClient(ctx, await mint({ role: 'driver' }))
  await expect(driver.request('swarm/token', { role: 'owner' })).rejects.toThrow(
    'FORBIDDEN: driver may not call swarm/token',
  )
}, 30_000)

it('swarm/events long-polls a live run, and swarm/cancel fails one', async () => {
  // A task turn slow enough to watch, then member turns that never answer.
  const ctx = await serve({
    sequence: ['slow_success', 'stall'],
    repeatLast: true,
    successText: 'done',
    chunkSize: 1,
    chunkDelayMs: 150,
  })
  const owner = await connectClient(ctx, ownerToken())

  // Progress: each poll returns what was appended after its cursor, waiting when nothing was.
  const { runId } = await owner.request('swarm/start', {
    ...route,
    spec: { topology: 'peer-team', members: [{ name: 'm' }], tasks: [{ subject: 'one', prompt: 'do one' }] },
  })
  const seen: any[] = []
  let polls = 0
  while (seen.at(-1)?.data.run?.status !== 'finished') {
    const { events } = await owner.request('swarm/events', { runId, afterSeq: seen.at(-1)?.seq ?? -1, waitMs: 10_000 })
    expect(events.length, 'a long-poll on a live run answers with something').toBeGreaterThan(0)
    seen.push(...events)
    polls++
  }
  expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
  expect(seen.map((e) => e.data.run?.status ?? e.data.task.status)).toEqual([
    'running',
    'pending',
    'in_progress',
    'completed',
    'finished',
  ])
  expect(polls).toBeGreaterThan(1)

  // Idle: nothing happens in a live run, so the poll answers empty once waitMs passes.
  const { runId: stuck } = await owner.request('swarm/start', {
    ...route,
    spec: { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'never answered' }] },
  })
  const t0 = Date.now()
  expect(await owner.request('swarm/events', { runId: stuck, afterSeq: 0, waitMs: 300 })).toEqual({ events: [] })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250)

  // Cancel: the run records failed, and a poll waiting on it hears so.
  const waiting = owner.request('swarm/events', { runId: stuck, afterSeq: 0, waitMs: 10_000 })
  expect(await owner.request('swarm/cancel', { runId: stuck })).toEqual({ cancelled: true })
  const { events } = await waiting
  expect(events.map((e: any) => [e.type, e.data.run.status, e.data.run.error])).toEqual([
    ['swarm/run', 'failed', `run ${stuck} cancelled`],
  ])
  expect((await runFinished(owner, stuck)).error).toBe(`run ${stuck} cancelled`)
  expect((await owner.request('swarm/runs')).runs.find((r: any) => r.id === stuck)).toMatchObject({
    status: 'failed',
    error: `run ${stuck} cancelled`,
  })
  // Settled, so no longer live: there is nothing left to cancel.
  await expect(owner.request('swarm/cancel', { runId: stuck })).rejects.toThrow(/^NOT_FOUND: /)
}, 30_000)
