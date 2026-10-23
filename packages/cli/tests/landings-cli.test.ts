/**
 * `openswarm landings` and `openswarm metrics` (docs/05 B4, B5): offline
 * verbs over the journals the landing scenario (a gated peer-team landed by
 * the train) writes into a temp OPENSWARM_HOME.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { landingScenario } from '../../swarm/tests/support/landing-scenario'
import { runControl } from '../src/index'

const originalHome = process.env['OPENSWARM_HOME']
afterEach(() => {
  process.env['OPENSWARM_HOME'] = originalHome
})

async function ctl(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runControl(argv, { out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

it('landings: the queue highest risk first, one block per landing, and --json; metrics: a table, priced by --pricing, and --json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'openswarm-landings-cli-'))
  process.env['OPENSWARM_HOME'] = home
  const { runId } = await landingScenario(join(home, 'runs'))

  const landings = await ctl('landings', runId)
  expect(landings.code).toBe(0)
  const lines = landings.out.split('\n')
  expect(lines[0]).toBe(`${runId}: 6 landing(s), 4 high, 1 medium, 1 low risk (highest first; read-only)`)
  const heads = lines.filter((line) => /^(HIGH|MEDIUM|LOW) /.test(line)).map((line) => line.split(/\s+/).slice(0, 3).join(' '))
  expect(heads).toEqual(['HIGH task-2 landed', 'HIGH task-5 landed', 'HIGH task-3 landed', 'HIGH task-1 ejected', 'MEDIUM task-0 landed', 'LOW task-4 landed'])
  expect(landings.out).toContain('why: gate waived by owner')
  expect(JSON.parse((await ctl('landings', runId, '--json')).out).map((l: any) => [l.key, l.risk])).toEqual([
    ['task-2', 'high'],
    ['task-5', 'high'],
    ['task-3', 'high'],
    ['task-1', 'high'],
    ['task-0', 'medium'],
    ['task-4', 'low'],
  ])

  const metrics = await ctl('metrics', runId)
  expect(metrics.code).toBe(0)
  const rows = metrics.out.split('\n')
  expect(rows[0]).toBe(runId)
  expect(rows).toContain('landed            5 (L2 4, L3 1)')
  expect(rows).toContain('dollars           — no pricing configured (SwarmConfig.pricing, or --pricing <file>)')
  expect(rows.find((row) => row.startsWith('landing '))).toMatch(/^landing +5 of 6 landed; landing rate 0\.83; clean-merge rate 0\.67; bisects 3; conflicts 1; latency median /)

  const pricing = join(home, 'pricing.json')
  writeFileSync(pricing, JSON.stringify({ 'model-a': { input: 5, output: 30, cacheRead: 0.5 }, 'model-b': { input: 1, output: 2 } }))
  const priced = await ctl('metrics', runId, '--pricing', pricing)
  expect(priced.out.split('\n').find((row) => row.startsWith('dollars'))).toMatch(/^dollars +\$0\.\d\d \(model-a \$0\.\d\d, model-b \$0\.00\)$/)
  expect((await ctl('landings', runId, '--pricing', pricing)).out).toMatch(/cost: 1,000 tokens \(task 1,000\), \$0\.01/)
  const json = JSON.parse((await ctl('metrics', runId, '--json', '--pricing', pricing)).out)
  expect(json).toMatchObject({ runId, landed: 5, dollars: { total: expect.any(Number) }, unsupported: {} })

  writeFileSync(pricing, JSON.stringify({ 'model-a': { input: 'five' } }))
  expect(await ctl('metrics', runId, '--pricing', pricing)).toMatchObject({ code: 1, err: expect.stringContaining('--pricing: model-a needs numeric input and output rates') })
  expect(await ctl('landings', 'run-0000none')).toMatchObject({ code: 1, err: 'unknown run "run-0000none"' })
  expect((await ctl('metrics')).code).toBe(2)
}, 60_000)
