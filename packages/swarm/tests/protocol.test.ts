/**
 * The swarm protocol (docs/05 §5.3), transport-free: calls go straight
 * through `dispatch` with a principal as a carrier would bind it.
 */
import { afterEach, expect, it } from 'vitest'
import { POLICY, dispatch, type MethodGroup, type Principal, type Role, type TeamSpec } from '../src/index'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const principals: Record<Role, Principal> = {
  owner: { role: 'owner' },
  viewer: { role: 'viewer' },
  driver: { role: 'driver' },
  member: { role: 'member', runId: 'run-00000000', member: 'm' },
}

/** The call's error message, or 'ok'. */
const outcome = (principal: Principal, method: string, params: unknown) =>
  dispatch(h!.ctx, principal, method, params).then(
    () => 'ok',
    (error: Error) => error.message,
  )

it('the policy matrix: each role reaches exactly its groups', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  const expected: Record<Role, MethodGroup[]> = {
    owner: ['state', 'direction', 'answer', 'admin'],
    viewer: ['state'],
    driver: ['state', 'direction'],
    member: ['member', 'state'],
  }
  // Every group, including the two with no Phase A method yet.
  expect(POLICY).toEqual(expected)
  // One call per group that has methods; a permitted call fails, if at all, for another reason.
  const probes: [MethodGroup, string, object][] = [
    ['state', 'swarm/runs', {}],
    ['direction', 'swarm/cancel', { runId: 'run-00000000' }],
    ['admin', 'swarm/token', { role: 'viewer' }],
  ]
  for (const role of Object.keys(principals) as Role[]) {
    for (const [group, method, params] of probes) {
      const result = await outcome(principals[role], method, params)
      if (expected[role].includes(group)) expect(result, `${role} × ${group}`).not.toMatch(/^FORBIDDEN/)
      else expect(result, `${role} × ${group}`).toBe(`FORBIDDEN: ${role} may not call ${method}`)
    }
  }
})

it('a bound principal is refused every other run, and lists only its own', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const spec: TeamSpec = { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'go' }] }
  const mine = await h.swarm.start(spec, { parent: h.lead.agent })
  const other = await h.swarm.start(spec, { parent: h.lead.agent })
  await Promise.all([mine.result, other.result])
  const member: Principal = { role: 'member', runId: mine.id, member: 'a' }

  const listed = (await dispatch(h.ctx, member, 'swarm/runs', {})) as { runs: { id: string }[] }
  expect(listed.runs.map((r) => r.id)).toEqual([mine.id])
  expect(await outcome(member, 'swarm/view', { runId: mine.id })).toBe('ok')
  for (const method of ['swarm/view', 'swarm/events']) {
    expect(await outcome(member, method, { runId: other.id })).toBe(
      `FORBIDDEN: ${method}: this principal is bound to run ${mine.id}`,
    )
  }
  // A member principal that names no run sees nothing.
  expect(await outcome({ role: 'member', member: 'a' }, 'swarm/runs', {})).toMatch(/^FORBIDDEN/)

  // A driver token scoped to a run directs that run only, and starts none.
  const driver: Principal = { role: 'driver', runId: mine.id }
  expect(await outcome(driver, 'swarm/cancel', { runId: other.id })).toMatch(/^FORBIDDEN: swarm\/cancel: /)
  expect(await outcome(driver, 'swarm/start', { spec, runId: mine.id })).toMatch(/^FORBIDDEN: swarm\/start: /)
  expect(await outcome(driver, 'swarm/cancel', { runId: mine.id })).toMatch(/^NOT_FOUND: /)
})

it('refuses unknown methods and malformed params, and reports unknown runs', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  const owner = principals.owner
  for (const method of ['swarm/nope', 'constructor']) {
    expect(await outcome(owner, method, {})).toBe(`UNKNOWN_METHOD: unknown swarm method: ${method}`)
  }
  const malformed: [string, unknown][] = [
    ['swarm/runs', null],
    ['swarm/view', {}],
    ['swarm/view', { runId: 7 }],
    ['swarm/view', { runId: '../../etc' }],
    ['swarm/events', { runId: 'run-00000000', waitMs: '5' }],
    ['swarm/start', { spec: 'fanout' }],
    ['swarm/steer', { runId: 'run-00000000', to: 'a' }],
    ['swarm/token', { role: 'root' }],
    ['swarm/token', { role: 'member', runId: 'run-00000000' }],
    ['swarm/token', { role: 'viewer', member: 'a' }],
  ]
  for (const [method, params] of malformed) {
    expect(await outcome(owner, method, params), `${method} ${JSON.stringify(params)}`).toMatch(/^INVALID_PARAMS: /)
  }
  for (const method of ['swarm/view', 'swarm/events', 'swarm/steer', 'swarm/cancel', 'swarm/attach']) {
    expect(await outcome(owner, method, { runId: 'run-00000000', to: 'a', text: 'hi' })).toMatch(/^NOT_FOUND: /)
  }
})
