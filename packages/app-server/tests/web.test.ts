/**
 * The web carrier, keyless and in process: dsh's typert registry and `/api`
 * gateway over the swarm test boot, invoking the carrier's `@Remote` methods
 * exactly as `POST /api/swarm/<method>` does (web-api.e2e.test.ts makes that
 * HTTP call against a real `openswarm-web` boot).
 */
import { afterEach, expect, it, vi } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import SwarmWebCarrier from '../src/web'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** A harness whose web server binds `host`: all the carrier reads of dsh's web server. */
async function boot(host: string): Promise<any> {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'web-answer' })
  const ctx = h.ctx as any
  ctx.provide('webServer', { host })
  ctx.plugin(TypertRegistry)
  ctx.plugin(TypertGatewayService)
  return ctx
}

it("serves the swarm protocol as the owner through dsh's gateway", async () => {
  const ctx = await boot('127.0.0.1')
  ctx.plugin(SwarmWebCarrier)
  await new Promise<void>((resolve) => ctx.inject(['typertGateway', 'swarmWeb'], () => resolve()))
  const call = (method: string, args: object): Promise<any> =>
    ctx.typertGateway.invoke({ namespace: 'swarm', method, args })

  expect(await call('runs', {})).toEqual({ runs: [] })
  const { runId } = await call('start', {
    spec: { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'go' }] },
    provider: 'deepseek-official',
    model: 'mock-model',
  })

  // A view follows the live run by long-polling events with the last seq.
  const seen: any[] = []
  while (seen.at(-1)?.data.run?.status !== 'finished') {
    seen.push(...(await call('events', { runId, afterSeq: seen.at(-1)?.seq ?? -1, waitMs: 10_000 })).events)
  }
  expect(seen[0]).toMatchObject({ seq: 0, type: 'swarm/run', data: { run: { id: runId, status: 'running' } } })
  expect(seen.at(-1).data.run.result.results[0].text).toContain('web-answer')
  expect((await call('view', { runId })).run).toMatchObject({ id: runId, status: 'finished' })
  expect((await call('runs', {})).runs.map((r: any) => [r.id, r.status])).toEqual([[runId, 'finished']])

  // Protocol refusals keep their code; the gateway checks args; tokens stay on the socket.
  await expect(call('steer', { runId: 'run-nope', to: 'a', text: 'hi' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
  await expect(call('runs', { bogus: 1 })).rejects.toMatchObject({ code: 'arguments-invalid' })
  await expect(call('token', { role: 'owner' })).rejects.toMatchObject({ code: 'invocation-unavailable' })
}, 30_000)

it('lists and answers questions as the owner through the gateway', async () => {
  const ctx = await boot('127.0.0.1')
  ctx.plugin(SwarmWebCarrier)
  await new Promise<void>((resolve) => ctx.inject(['typertGateway', 'swarmWeb'], () => resolve()))
  const call = (method: string, args: object): Promise<any> =>
    ctx.typertGateway.invoke({ namespace: 'swarm', method, args })

  // A run held live by a command gate that waits, raising one question.
  let pass!: (score: number) => void
  const gate = new Promise<number>((resolve) => (pass = resolve))
  const run = await h!.swarm.start(
    { topology: 'cascade', tiers: [{ name: 't' }], task: 'hold', confidence: { commands: ['true'], tau: 1 } },
    { parent: h!.lead.agent, confidenceRunner: () => gate, questions: { timeoutMs: 60_000 } },
  )
  const asked = run.ask({ trigger: 'stall', prompt: 'restart or wait?', options: ['restart', 'wait'], default: 'restart' })
  await vi.waitFor(async () => expect((await call('questions', {})).questions).toHaveLength(1))
  expect((await call('questions', { runId: run.id })).questions).toEqual([
    expect.objectContaining({ runId: run.id, id: 'q-0', prompt: 'restart or wait?', status: 'open' }),
  ])
  expect(await call('answer', { runId: run.id, questionId: 'q-0', answer: 'wait' })).toEqual({ answered: true })
  expect(await asked).toBe('wait')
  expect(h!.swarm.view(run.id).questions[0]).toMatchObject({ status: 'answered', answer: 'wait', by: 'owner' })
  pass(1)
  await run.result
}, 30_000)

it('refuses to load unless the web server binds loopback', async () => {
  const ctx = await boot('0.0.0.0')
  await expect(ctx.plugin(SwarmWebCarrier).await()).rejects.toThrow(
    "openswarm-app-server/web: dsh's web server binds 0.0.0.0",
  )
  expect(ctx.get('swarmWeb')).toBeUndefined()
})
