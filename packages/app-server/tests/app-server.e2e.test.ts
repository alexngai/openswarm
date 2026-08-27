/**
 * App-server E2E, keyless: a raw JSON-RPC client over TCP exercises both
 * halves of the wrapped surface — the delegated dsh SDK protocol
 * (initialize handshake, streamed session events) and the swarm extension
 * (runTeam → runFinished notification, runs, board).
 */
import { connect } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import AppServer from '../src/index'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'

let h: TestHarness | undefined
let client: JsonRpcLineTransport | undefined
let socket: ReturnType<typeof connect> | undefined
afterEach(async () => {
  client?.close()
  socket?.destroy()
  client = undefined
  socket = undefined
  await (h as any)?.ctx?.swarmAppServer?.close()
  await h?.close()
  h = undefined
})

it('serves the delegated SDK protocol and the swarm extension over one socket', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'wire-answer' })
  const ctx = (h as any).ctx
  ctx.plugin(AppServer, {})
  await new Promise<void>((resolve) => ctx.inject(['swarmAppServer'], () => resolve()))
  await ctx.swarmAppServer.ready
  const [host, port] = ctx.swarmAppServer.url.split(':')

  socket = connect({ host, port: Number(port) })
  await new Promise<void>((resolve, reject) => {
    socket!.once('connect', () => resolve())
    socket!.once('error', reject)
  })
  client = new JsonRpcLineTransport(socket, socket)
  const notifications: { method: string; params: any }[] = []
  client.onNotification((method, params) => notifications.push({ method, params }))
  client.start()

  // Delegated half: the dsh SDK handshake answers with its wire identity.
  const init = (await client.request('initialize', {
    cwd: process.cwd(),
    provider: 'deepseek-official',
    model: 'mock-model',
  })) as any
  expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

  // Swarm half: run a fanout team; completion arrives as a notification.
  const { runId } = (await client.request('swarm/runTeam', {
    provider: 'deepseek-official',
    model: 'mock-model',
    spec: {
      topology: 'fanout',
      members: [{ name: 'a' }, { name: 'b' }],
      tasks: [
        { member: 'a', prompt: 'first' },
        { member: 'b', prompt: 'second' },
      ],
    },
  })) as any
  expect(runId).toMatch(/^run-/)

  const finished = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runFinished never arrived')), 20_000)
    const poll = setInterval(() => {
      const n = notifications.find((x) => x.method === 'swarm.runFinished')
      if (n !== undefined) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve(n.params)
      }
    }, 25)
  })
  expect(finished.runId).toBe(runId)
  expect(finished.result.topology).toBe('fanout')
  expect(finished.result.results).toHaveLength(2)
  expect(finished.result.results[0].text).toContain('wire-answer')

  // The delegated event stream flowed: member session events reached the wire.
  expect(notifications.some((n) => n.method === 'session.event')).toBe(true)

  // Run registry reflects completion.
  const runs = (await client.request('swarm/runs', {})) as any
  expect(runs.runs).toEqual([
    { runId, status: 'finished', leadSessionId: expect.stringContaining('swarm-app-') },
  ])

  // Unknown swarm methods reject cleanly.
  await expect(client.request('swarm/nope', {})).rejects.toMatchObject({
    message: expect.stringContaining('unknown swarm method'),
  })
}, 30_000)

it('board state is queryable per run', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const ctx = (h as any).ctx
  ctx.plugin(AppServer, {})
  await new Promise<void>((resolve) => ctx.inject(['swarmAppServer'], () => resolve()))
  await ctx.swarmAppServer.ready
  const [host, port] = ctx.swarmAppServer.url.split(':')
  socket = connect({ host, port: Number(port) })
  await new Promise<void>((resolve) => socket!.once('connect', () => resolve()))
  client = new JsonRpcLineTransport(socket, socket)
  const notifications: { method: string; params: any }[] = []
  client.onNotification((method, params) => notifications.push({ method, params }))
  client.start()

  const { runId } = (await client.request('swarm/runTeam', {
    provider: 'deepseek-official',
    model: 'mock-model',
    spec: {
      topology: 'peer-team',
      members: [{ name: 'solo' }],
      tasks: [{ subject: 'one', prompt: 'do one' }],
    },
  })) as any
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (notifications.some((n) => n.method === 'swarm.runFinished')) {
        clearInterval(poll)
        resolve()
      }
    }, 25)
  })
  const done = notifications.find((n) => n.method === 'swarm.runFinished')!
  expect(done.params.error, JSON.stringify(done.params)).toBeUndefined()

  // The per-run lead is disposed once the run settles (no unbounded lead
  // accumulation on a long-lived server)...
  const runs = (await client.request('swarm/runs', {})) as any
  const leadId = runs.runs.find((r: any) => r.runId === runId)!.leadSessionId
  expect(ctx.agents.get(leadId)).toBeUndefined()

  // ...yet swarm/board still answers from the snapshot captured at finish.
  const board = (await client.request('swarm/board', { runId })) as any
  expect(board.tasks).toHaveLength(1)
  expect(board.tasks[0]).toMatchObject({ subject: 'one', status: 'completed', owner: 'solo' })
}, 30_000)
