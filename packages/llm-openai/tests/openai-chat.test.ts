/**
 * Keyless adapter tests: the openai-chat routes against the upstream
 * scriptable mock (which speaks chat-completions SSE), through the full
 * agent loop. The load-bearing assertions are on the captured wire: no
 * `thinking`, no `reasoning_effort`, no `max_tokens` — the exact fields the
 * live Azure probe showed strict endpoints rejecting.
 */
import { afterEach, expect, it } from 'vitest'
import * as OpenAiChat from '../src/index'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

// bootHarness exports the mock URL as DEEPSEEK_BASE_URL before plugins mount;
// the adapter resolves its base per request from this env variable.
const OPENAI_PLUGIN = (models = [{ id: 'mock-model', contextWindow: 128_000 }]) => ({
  module: OpenAiChat,
  config: {
    routes: ['openai'],
    baseURLEnv: 'DEEPSEEK_BASE_URL',
    apiKeyEnv: 'OPENSWARM_LLM_API_KEY',
    models,
  },
  provider: 'openai',
  model: 'mock-model',
})

it('serves a clean chat-completions wire: no thinking, effort, or max_tokens', async () => {
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'
  h = await bootHarness(
    { sequence: ['success'], repeatLast: true, successText: 'clean-wire' },
    undefined,
    OPENAI_PLUGIN(),
  )
  const result = await h.swarm.runTeam(
    { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'say something' }] },
    { parent: h.lead.agent },
  )
  if (result.topology !== 'fanout') throw new Error('wrong topology')
  expect(result.results[0]!.stopReason).toBe('completed')
  expect(result.results[0]!.text).toContain('clean-wire')

  expect(h.mock.requests.length).toBeGreaterThan(0)
  for (const request of h.mock.requests) {
    const body = request.body as Record<string, unknown>
    expect(body['thinking']).toBeUndefined()
    expect(body['reasoning_effort']).toBeUndefined()
    expect(body['max_tokens']).toBeUndefined()
    expect(body['model']).toBe('mock-model')
    expect(body['stream']).toBe(true)
  }
})

it('streams scripted tool calls through the clean wire', async () => {
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'
  h = await bootHarness(
    {
      // The member has no tools registered in the in-process spine, so the
      // scripted call fails as an unknown tool — which still proves the
      // adapter translated the streamed tool-call blocks; the loop then owes
      // a follow-up request that closes the turn.
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      successText: 'after-tool',
      toolName: 'not_registered',
      toolArguments: JSON.stringify({ x: 1 }),
    },
    undefined,
    OPENAI_PLUGIN(),
  )
  const result = await h.swarm.runTeam(
    { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'p' }] },
    { parent: h.lead.agent },
  )
  if (result.topology !== 'fanout') throw new Error('wrong topology')
  expect(result.results[0]!.stopReason).toBe('completed')
  expect(result.results[0]!.text).toContain('after-tool')
  // The follow-up request carried the tool result back over the same wire.
  expect(h.mock.requests.length).toBe(2)
})

it('fails loud without the configured credential', async () => {
  delete process.env['OPENSWARM_MISSING_KEY']
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'x' }, undefined, {
    ...OPENAI_PLUGIN(),
    config: {
      routes: ['openai'],
      baseURLEnv: 'DEEPSEEK_BASE_URL',
      apiKeyEnv: 'OPENSWARM_MISSING_KEY',
      models: [{ id: 'mock-model' }],
    },
  })
  const result = await h.swarm.runTeam(
    { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'p' }] },
    { parent: h.lead.agent },
  )
  if (result.topology !== 'fanout') throw new Error('wrong topology')
  expect(result.results[0]!.stopReason).toBe('error')
})
