/**
 * Boot a swarm context outside vitest.
 *
 * `packages/swarm/tests/boot.ts` does this for tests, but it is TypeScript and
 * imports package sources through a vitest alias. The eval package is plain
 * ESM, so it composes the same tree against the BUILT dist instead — which also
 * means the experiment drives the same artifact a real run does, rather than a
 * test-only view of it. Requires `npm run build`.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import * as Spine from '@deepseek-ai/dsh-agent-spine-demo'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Subagent from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plug = (m) => m?.default ?? m

/** Resolve the built swarm service (fails loud if the build is stale/absent). */
async function swarmService() {
  const mod = await import('../packages/swarm/dist/index.js')
  const Service = mod.default ?? mod.SwarmService
  if (typeof Service !== 'function') {
    throw new Error('openswarm-swarm dist has no default export — run `npm run build`')
  }
  return Service
}

let leadCounter = 0

/**
 * Compose a harness whose model turns are served by a scripted mock — zero
 * tokens, no credentials. `mockOptions` is the same shape the test harness uses.
 */
export async function bootMock(mockOptions) {
  const mock = await startMockLlmServer({ apiKey: 'mock-key', ...mockOptions })
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  process.env['DEEPSEEK_BASE_URL'] = base
  process.env['DEEPSEEK_API_KEY'] = 'mock-key'

  const workDir = mkdtempSync(join(tmpdir(), 'openswarm-eval-'))
  const ctx = new Context()
  ctx.plugin(plug(LlmDeepseek), { models: [{ id: 'mock-model', contextWindow: 128_000 }] })
  ctx.plugin(plug(Spine), {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: 'You are an eval agent.',
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
  })
  ctx.plugin(plug(SessionPersistenceJsonl), { root: join(workDir, '.sessions'), compression: 'none' })
  ctx.plugin(plug(Subagent))
  ctx.plugin(plug(SpawnInProcess), { providerName: 'spawn' })
  ctx.plugin(await swarmService(), {})

  await new Promise((resolve) =>
    ctx.inject(['agents', 'subagents', 'swarm', 'sessionPersistence'], () => resolve()),
  )

  // `runTeam` returns no usage, so fold it off the session-event stream the way
  // packages/cli does — same source, same field names. Without this the eval
  // loses its cost axis, which is the outcome with the most statistical power
  // we have (continuous, versus a noisy binary pass/fail).
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 0, calls: 0 }
  ctx.on('session/event', (_session, event) => {
    if (event?.type !== 'assistant/message') return
    const usage = event.data?.usage
    if (usage === undefined) return
    totals.inputTokens += usage.inputTokens ?? 0
    totals.outputTokens += usage.outputTokens ?? 0
    totals.cacheReadInputTokens += usage.cacheReadTokens ?? 0
    totals.cacheWriteInputTokens += usage.cacheWriteTokens ?? 0
    totals.calls += 1
    totals.totalTokens =
      totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens + totals.cacheWriteInputTokens
  })

  const lead = await ctx.agents.create({
    sessionId: SessionId(`openswarm-eval-lead-${process.pid}-${leadCounter++}`),
    meta: { cwd: workDir },
    agentOptions: { provider: 'deepseek-official', model: 'mock-model' },
  })

  /** Env a subprocess member needs to reach the same mock. */
  const memberEnv = {
    OPENSWARM_LLM_BASE_URL: base,
    OPENSWARM_LLM_API_KEY: 'mock-key',
    DSH_MODEL: 'mock-model',
  }

  return {
    ctx,
    swarm: ctx.swarm,
    lead,
    mock,
    memberEnv,
    /** Token totals folded across every session this harness drove. */
    usage: () => ({ ...totals }),
    async close() {
      await lead.dispose()
      await ctx.fiber?.dispose?.()
      await mock.close()
    },
  }
}
