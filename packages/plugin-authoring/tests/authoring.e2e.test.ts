/**
 * F3 E2E: an agent authors a plugin via swarm_author_plugin and the new
 * tool it registers is callable in the same run. Drives the real tool
 * pipeline through the mock; the authored tool's effect is observed on the
 * agent's transcript. Also covers the blast-radius policy: lead-scope is
 * refused without approval and admitted with it.
 */
import { afterEach, expect, it } from 'vitest'
import * as PluginAuthoring from '../src/index'
import { userApprovalGate } from '../src/index'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** A plugin source that registers a `shout` tool echoing its text uppercased. */
const SHOUT_PLUGIN = `
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'shout',
    description: 'Uppercase the given text.',
    parameters: { text: { type: 'string', required: true, description: 'text' } },
    output: {
      schema: { type: 'object', properties: { shouted: { type: 'string', required: true } }, additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.shouted }],
    },
    execute: (args) => Promise.resolve({ shouted: String(args.text).toUpperCase() }),
  }))
}
`

async function boot(approveLead = false): Promise<TestHarness> {
  const harness = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'x' })
  const ctx = (harness as any).ctx
  ctx.plugin(PluginAuthoring, approveLead ? { approveLeadMount: () => true } : {})
  await new Promise<void>((resolve) => ctx.inject(['tools'], () => resolve()))
  return harness
}

/** Invoke a registered tool directly through the runtime (bypassing the model). */
async function callTool(h: TestHarness, name: string, args: unknown): Promise<any> {
  const ctx = (h as any).ctx
  return ctx.tools.execute({
    callId: `call-${Math.abs(Date.now() % 1e6)}`,
    name,
    arguments: args,
    agent: h.lead.agent,
    signal: new AbortController().signal,
  })
}

it('an authored self-scope plugin registers a working tool', async () => {
  h = await boot()
  const result = await callTool(h, 'swarm_author_plugin', {
    name: 'shouter',
    scope: 'self',
    source: SHOUT_PLUGIN,
  })
  expect(result.value ?? result).toMatchObject({ mounted: true, scope: 'self' })

  // The freshly authored tool is now live and callable.
  const shout = await callTool(h, 'shout', { text: 'hello swarm' })
  expect((shout.value ?? shout).shouted).toBe('HELLO SWARM')
})

it('a malformed plugin is refused without crashing the harness', async () => {
  h = await boot()
  const result = await callTool(h, 'swarm_author_plugin', {
    name: 'broken',
    scope: 'self',
    source: 'export function apply(ctx) { throw new Error("boom") }',
  })
  const value = result.value ?? result
  expect(value.mounted).toBe(false)
  expect(value.reason).toContain('boom')
  // The harness still works: author a good one afterward.
  const ok = await callTool(h, 'swarm_author_plugin', { name: 'shouter', scope: 'self', source: SHOUT_PLUGIN })
  expect((ok.value ?? ok).mounted).toBe(true)
})

it('lead-scope is refused without approval and admitted with it', async () => {
  h = await boot(false)
  const denied = await callTool(h, 'swarm_author_plugin', { name: 'l', scope: 'lead', source: SHOUT_PLUGIN })
  expect(result(denied)).toMatchObject({ mounted: false, scope: 'lead' })
  expect(result(denied).reason).toContain('not approved')

  await h.close()
  h = await boot(true)
  const allowed = await callTool(h, 'swarm_author_plugin', { name: 'l', scope: 'lead', source: SHOUT_PLUGIN })
  expect(result(allowed)).toMatchObject({ mounted: true, scope: 'lead' })
  // Lead-scope tool is visible at the root too.
  const shout = await callTool(h, 'shout', { text: 'root' })
  expect(result(shout).shouted).toBe('ROOT')
})

function result(r: any): any {
  return r.value ?? r
}

/** A ctx exposing only what the default gate reaches for: `ctx.get('approval')`. */
function ctxWithApproval(approval: unknown): any {
  return { get: (name: string) => (name === 'approval' ? approval : undefined) }
}

const leadRequest = {
  agent: { id: 'a1' } as never,
  agentId: 'a1',
  name: 'shouter',
  source: SHOUT_PLUGIN,
  callId: 'call-1',
}

it('the default gate asks ctx.approval and grants only on allowed-once', async () => {
  const asked: any[] = []
  const gate = (outcome: string) =>
    userApprovalGate(
      ctxWithApproval({
        request: (req: unknown) => {
          asked.push(req)
          return Promise.resolve(outcome)
        },
      }),
    )

  expect(await gate('allowed-once')(leadRequest)).toBe(true)
  // The question reached the seam naming the tool and why it is asking.
  expect(asked[0]).toMatchObject({ toolName: 'swarm_author_plugin', callId: 'call-1' })
  expect(asked[0].reason).toContain('SHARED harness')

  // Every other outcome in the seam's vocabulary denies.
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    expect(await gate(outcome)(leadRequest), outcome).toBe(false)
  }
})

it('the default gate fails closed with no approval service and on a throwing one', async () => {
  // No service composed (a bare headless context): nobody to ask.
  expect(await userApprovalGate(ctxWithApproval(undefined))(leadRequest)).toBe(false)
  // The seam rejects an ask outside an open turn — still nobody granted it.
  const throwing = ctxWithApproval({
    request: () => Promise.reject(new Error('no turn is open')),
  })
  expect(await userApprovalGate(throwing)(leadRequest)).toBe(false)
})
