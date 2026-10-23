// A lead process for the attach e2e (docs/05 §7.3 exit criterion 2): the
// swarm over the scripted mock LLM, from the built dist, running the peer-team
// spec in argv[2] under $OPENSWARM_HOME/runs. The first member turn completes
// and every later one stalls, so claims stay held until the process is killed.
// Prints the run id.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import * as Spine from '@deepseek-ai/dsh-agent-spine-demo'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Subagent from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SwarmService from 'openswarm-swarm'

const plug = (m) => m.default ?? m
const mock = await startMockLlmServer({ sequence: ['success', 'stall'], repeatLast: true, successText: 'done' })
process.env.DEEPSEEK_BASE_URL = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
process.env.DEEPSEEK_API_KEY = 'mock-key'

const ctx = new Context()
ctx.plugin(plug(LlmDeepseek), { models: [{ id: 'mock-model', contextWindow: 128_000 }] })
ctx.plugin(plug(Spine), {
  includeHarnessIdentity: false,
  includeRuntimeContext: false,
  persona: 'You are a test agent.',
  workspaceContext: false,
  skills: { enabled: false },
  toolBash: false,
  toolJobs: false,
})
ctx.plugin(plug(SessionPersistenceJsonl), { root: mkdtempSync(join(tmpdir(), 'openswarm-lead-')), compression: 'none' })
ctx.plugin(plug(Subagent))
ctx.plugin(plug(SpawnInProcess), { providerName: 'spawn' })
ctx.plugin(SwarmService, {})
await new Promise((resolve) => ctx.inject(['agents', 'subagents', 'swarm', 'sessionPersistence'], () => resolve()))

const lead = await ctx.agents.create({
  sessionId: `lead-${process.pid}`,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: 'deepseek-official', model: 'mock-model' },
})
const run = await ctx.swarm.start(JSON.parse(process.argv[2]), { parent: lead.agent })
process.stdout.write(`${run.id}\n`)
