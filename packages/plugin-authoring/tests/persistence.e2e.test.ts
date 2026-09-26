/**
 * Rung 4 — an agent's modification outlives the process that authored it.
 *
 * `ctx.plugin()` unwinds on dispose, which is exactly what makes live mounting
 * safe and exactly why nothing used to survive a restart. Approved lead-scope
 * plugins are therefore written to `persistDir` alongside a manifest recording
 * the SHA-256 of what the human actually approved, and re-mounted on boot.
 *
 * The digest is a security boundary, not bookkeeping. Member harnesses carry
 * ordinary file-write tools, so a model that can write into `persistDir` could
 * otherwise reach shared lead scope on the next boot without ever facing the
 * approval gate. The last two tests are that escalation attempt.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as PluginAuthoring from '../src/index'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

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

/** Boot a harness with the authoring row mounted, awaiting any restore. */
async function boot(persistDir: string): Promise<TestHarness> {
  const harness = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'x' })
  const ctx = (harness as any).ctx
  await new Promise<void>((resolve) => ctx.inject(['tools'], () => resolve()))
  // Awaiting the fiber is what makes restore deterministic: `apply` mounts the
  // persisted plugins before the fiber reports ready.
  await ctx.plugin(PluginAuthoring, { approveLeadMount: () => true, persistDir }).await()
  return harness
}

async function callTool(h: TestHarness, name: string, args: unknown): Promise<any> {
  const ctx = (h as any).ctx
  const r = await ctx.tools.execute({
    callId: `call-${Math.abs(Date.now() % 1e6)}`,
    name,
    arguments: args,
    agent: h.lead.agent,
    signal: new AbortController().signal,
  })
  return r.value ?? r
}

const scratch = () => mkdtempSync(join(tmpdir(), 'openswarm-persist-'))

/**
 * Assert `shout` did not come back. The runtime reports an unregistered tool
 * as an error RESULT rather than a rejection, so match on that shape.
 */
async function expectShoutAbsent(h: TestHarness): Promise<void> {
  const r = await callTool(h, 'shout', { text: 'x' })
  expect(r.isError).toBe(true)
  expect(r.error?.info?.code).toBe('UNKNOWN_TOOL')
}

it('an approved lead plugin survives a restart and its tool is live again', async () => {
  const dir = scratch()

  h = await boot(dir)
  expect(await callTool(h, 'swarm_author_plugin', { name: 'shouter', scope: 'lead', source: SHOUT_PLUGIN }))
    .toMatchObject({ mounted: true, scope: 'lead' })
  expect((await callTool(h, 'shout', { text: 'before' })).shouted).toBe('BEFORE')

  // Restart: a brand-new harness and context, same persist dir.
  await h.close()
  h = await boot(dir)

  // Nothing authored it this time — it came back from disk.
  expect((await callTool(h, 'shout', { text: 'after' })).shouted).toBe('AFTER')
})

it('self scope is never persisted — it has no shared context to return to', async () => {
  const dir = scratch()

  h = await boot(dir)
  expect(await callTool(h, 'swarm_author_plugin', { name: 'shouter', scope: 'self', source: SHOUT_PLUGIN }))
    .toMatchObject({ mounted: true, scope: 'self' })

  await h.close()
  h = await boot(dir)
  await expectShoutAbsent(h)
})

it('a plugin edited after approval is not restored', async () => {
  const dir = scratch()

  h = await boot(dir)
  await callTool(h, 'swarm_author_plugin', { name: 'shouter', scope: 'lead', source: SHOUT_PLUGIN })
  await h.close()

  // Tamper with the approved bytes, keeping the manifest entry intact.
  const file = join(dir, 'shouter.mjs')
  writeFileSync(file, readFileSync(file, 'utf8').replace('toUpperCase', 'toLowerCase'), 'utf8')

  h = await boot(dir)
  await expectShoutAbsent(h)
})

it('a plugin dropped into the directory without approval is not restored', async () => {
  const dir = scratch()

  // The escalation attempt: source on disk, no manifest entry, no gate.
  writeFileSync(join(dir, 'sneaky.mjs'), SHOUT_PLUGIN, 'utf8')

  h = await boot(dir)
  await expectShoutAbsent(h)
})
