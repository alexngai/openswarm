import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SwarmJournal } from '../src/journal'

/** A journal path whose parent directory does not exist yet. */
const freshPath = () => join(mkdtempSync(join(tmpdir(), 'openswarm-journal-test-')), 'run', 'journal.jsonl')

it('reopening replays identical events and continues seq', async () => {
  const path = freshPath()
  const journal = SwarmJournal.open(path)
  await journal.append('a', { n: 1 })
  // Concurrent appends (board and mailbox share a journal) land in seq order.
  await Promise.all(Array.from({ length: 10 }, (_, n) => journal.append('b', { n })))

  const reopened = SwarmJournal.open(path)
  expect(reopened.events).toEqual(journal.events)
  expect(reopened.events.map((e) => e.seq)).toEqual(Array.from({ length: 11 }, (_, n) => n))
  expect((await reopened.append('c', {})).seq).toBe(11)
})

it('a torn final line from a crashed writer is skipped and cut off', async () => {
  const path = freshPath()
  await SwarmJournal.open(path).append('a', {})
  appendFileSync(path, '{"seq":1,"time":0,"type":"b","da')

  const reopened = SwarmJournal.open(path)
  expect(reopened.events.map((e) => e.type)).toEqual(['a'])
  // The next append starts a clean line rather than extending the torn one.
  await reopened.append('c', {})
  expect(SwarmJournal.open(path).events.map((e) => [e.seq, e.type])).toEqual([
    [0, 'a'],
    [1, 'c'],
  ])
})

it('each open mints a new incarnation', () => {
  const path = freshPath()
  expect(SwarmJournal.open(path).incarnation).not.toBe(SwarmJournal.open(path).incarnation)
})
