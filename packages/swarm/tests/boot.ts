/**
 * In-process test boot: the real dsh spine (llm runtime, sessions, agents,
 * agent loop, tools), the stock DeepSeek adapter pointed at the scriptable
 * mock LLM server, the in-process spawn subagent provider, and ctx.swarm.
 * No API keys; every model turn is scripted per test.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  startMockLlmServer,
  type MockLlmServer,
  type MockLlmServerOptions,
} from '@deepseek-ai/dsh-llm-mock-server'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import * as Spine from '@deepseek-ai/dsh-agent-spine-demo'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Subagent from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SwarmService from '../src/index'

/** Loader-style default unwrap for hand-mounted plugin modules. */
const plug = (m: unknown): any => (m as any).default ?? m

export interface TestHarness {
  ctx: Context
  swarm: SwarmService
  lead: AgentHandle
  mock: MockLlmServer
  close(): Promise<void>
}

let leadCounter = 0

export async function bootHarness(mockOptions: MockLlmServerOptions): Promise<TestHarness> {
  const mock = await startMockLlmServer({ apiKey: 'mock-key', ...mockOptions })
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  process.env['DEEPSEEK_BASE_URL'] = base
  process.env['DEEPSEEK_API_KEY'] = 'mock-key'

  const workDir = mkdtempSync(join(tmpdir(), 'openswarm-swarm-test-'))
  const ctx = new Context()
  ctx.plugin(plug(LlmDeepseek), {
    models: [{ id: 'mock-model', contextWindow: 128_000 }],
  })
  ctx.plugin(plug(Spine), {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: 'You are a test agent.',
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
  })
  ctx.plugin(plug(SessionPersistenceJsonl), {
    root: join(workDir, '.sessions'),
    compression: 'none',
  })
  ctx.plugin(plug(Subagent))
  ctx.plugin(plug(SpawnInProcess), { providerName: 'spawn' })
  ctx.plugin(SwarmService, {})

  // Wait until every service the tests touch is registered and active.
  await new Promise<void>((resolve) =>
    ctx.inject(['agents', 'subagents', 'swarm', 'sessionPersistence'], () => resolve()),
  )

  const lead = await ctx.agents.create({
    sessionId: SessionId(`swarm-test-lead-${process.pid}-${leadCounter++}`),
    meta: { cwd: workDir },
    agentOptions: { provider: 'deepseek-official', model: 'mock-model' },
  })

  return {
    ctx,
    swarm: ctx.swarm,
    lead,
    mock,
    async close() {
      await lead.dispose()
      await (ctx as any).fiber?.dispose?.()
      await mock.close()
    },
  }
}
