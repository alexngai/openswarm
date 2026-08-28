/**
 * Warm-restart context recovery: a dead member's persisted log folded into
 * briefing text for its replacement. Hand-written JSONL rather than a spawned
 * child, so the fold is tested independently of the runtime that writes it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { digestSessionLog, findSessionLog, renderRecoveryBriefing } from '../src/recover'

/** Write a log where the persistence plugin puts one: <root>/<slug>/<id>/. */
function storeWithLog(sessionId: string, lines: unknown[]): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-recover-'))
  const dir = join(root, '-some-workspace-slug-', sessionId)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { root, log }
}

const asked = (text: string) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const said = (text: string) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})

it('finds a session log nested under the persistence root', () => {
  const { root, log } = storeWithLog('swarm-member-alice', [asked('do the thing')])
  expect(findSessionLog(root, 'swarm-member-alice')).toBe(log)
  expect(findSessionLog(root, 'swarm-member-nobody')).toBeUndefined()
})

it('folds a log into what the member was asked and what it reported', () => {
  const { log } = storeWithLog('swarm-member-bob', [
    asked('You are bob. Acknowledge.'),
    said('Acknowledged.'),
    asked('refactor the parser'),
    { type: 'tool/call', data: { name: 'bash' } }, // not a message: ignored
    said('I rewrote tokenize() and added tests.'),
  ])
  const digest = digestSessionLog(log)
  expect(digest.asked).toEqual(['You are bob. Acknowledge.', 'refactor the parser'])
  expect(digest.reported).toEqual(['Acknowledged.', 'I rewrote tokenize() and added tests.'])
})

it('survives the torn final line a crash leaves behind', () => {
  const { root } = storeWithLog('swarm-member-torn', [asked('a'), said('b')])
  const log = findSessionLog(root, 'swarm-member-torn')!
  writeFileSync(log, `${JSON.stringify(asked('a'))}\n${JSON.stringify(said('b'))}\n{"type":"assis`)
  const digest = digestSessionLog(log)
  expect(digest.asked).toEqual(['a'])
  expect(digest.reported).toEqual(['b'])
})

it('renders briefing context that names the work and points at the worktree', () => {
  const briefing = renderRecoveryBriefing({
    asked: ['refactor the parser'],
    reported: ['I rewrote tokenize().'],
  })!
  expect(briefing).toContain('previous process ended')
  expect(briefing).toContain('refactor the parser')
  expect(briefing).toContain('I rewrote tokenize().')
  // The worktree is the half that genuinely survives; say so.
  expect(briefing).toContain('worktree')
})

it('renders nothing when there is nothing recovered', () => {
  expect(renderRecoveryBriefing({ asked: [], reported: [] })).toBeUndefined()
  expect(digestSessionLog('/nonexistent/session.jsonl')).toEqual({ asked: [], reported: [] })
})

it('bounds the briefing so a long history cannot crowd out the task', () => {
  const digest = {
    asked: Array.from({ length: 50 }, (_, i) => `ask ${i} ${'x'.repeat(2_000)}`),
    reported: Array.from({ length: 50 }, (_, i) => `said ${i} ${'y'.repeat(2_000)}`),
  }
  const briefing = renderRecoveryBriefing(digest, 1_000)!
  expect(briefing.length).toBeLessThanOrEqual(1_001)
  // Keeps the most recent, which describes the state the worktree is in.
  expect(renderRecoveryBriefing(digest)).toContain('ask 49')
})
