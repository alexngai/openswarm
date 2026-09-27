import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SwarmBoard, SwarmBoardError, foldBoard } from '../src/board'
import { SwarmJournal } from '../src/journal'
import type { SwarmQuestionRequest } from '../src/run'
import type { MemberSpec } from '../src/types'

async function bootBoard() {
  const journal = SwarmJournal.open(join(mkdtempSync(join(tmpdir(), 'openswarm-board-test-')), 'journal.jsonl'))
  return { board: new SwarmBoard(journal), journal }
}

it('create → claim → complete round-trips with revisions and results', async () => {
  const { board } = await bootBoard()
  const created = await board.create({ subject: 's', prompt: 'p' })
  expect(created).toMatchObject({ id: 'task-0', revision: 0, status: 'pending', blockedBy: [] })
  const claimed = await board.claim(created.id, 'alice', created.revision)
  expect(claimed).toMatchObject({ revision: 1, status: 'in_progress', owner: 'alice' })
  const completed = await board.complete(created.id, 'alice', claimed.revision, 'the result')
  expect(completed).toMatchObject({ revision: 2, status: 'completed', result: 'the result' })
  expect(board.list()).toHaveLength(1)
})

it('stale revisions, wrong owners, and unknown blockers fail loud', async () => {
  const { board } = await bootBoard()
  const t = await board.create({ subject: 's', prompt: 'p' })
  await board.claim(t.id, 'alice', 0)
  await expect(board.claim(t.id, 'bob', 0)).rejects.toMatchObject({
    code: 'SWARM_TASK_STALE_REVISION',
  })
  await expect(board.complete(t.id, 'bob', 1)).rejects.toMatchObject({
    code: 'SWARM_TASK_WRONG_OWNER',
  })
  await expect(board.create({ subject: 'x', prompt: 'p', blockedBy: ['task-99'] })).rejects.toBeInstanceOf(
    SwarmBoardError,
  )
})

it('blocked tasks are not ready until every blocker completes', async () => {
  const { board } = await bootBoard()
  const a = await board.create({ subject: 'a', prompt: 'p' })
  const b = await board.create({ subject: 'b', prompt: 'p', blockedBy: [a.id] })
  await expect(board.claim(b.id, 'alice', b.revision)).rejects.toMatchObject({
    code: 'SWARM_TASK_NOT_READY',
  })
  expect(await board.claimNextReady('alice')).toMatchObject({ id: a.id })
  await board.complete(a.id, 'alice', 1, 'done')
  expect(await board.claimNextReady('alice')).toMatchObject({ id: b.id })
})

it('release returns a task to pending without its owner', async () => {
  const { board } = await bootBoard()
  const t = await board.create({ subject: 's', prompt: 'p' })
  const claimed = await board.claim(t.id, 'alice', 0)
  const released = await board.release(t.id, 'alice', claimed.revision)
  expect(released.status).toBe('pending')
  expect(released.owner).toBeUndefined()
  expect(released.lease).toBeUndefined()
  expect(await board.claimNextReady('bob')).toMatchObject({ id: t.id, owner: 'bob' })
})

it('board state is a pure fold of the run journal', async () => {
  const { board, journal } = await bootBoard()
  const a = await board.create({ subject: 'a', prompt: 'p' })
  await board.claim(a.id, 'alice', 0)
  await board.complete(a.id, 'alice', 1, 'r')
  await board.create({ subject: 'b', prompt: 'p' })

  // Replaying the raw journal reproduces the board...
  const folded = foldBoard(journal.events)
  expect([...folded.values()]).toEqual(board.list())
  // ...and a fresh board over the same journal sees identical state and
  // continues the id sequence instead of reusing task ids.
  const rebuilt = new SwarmBoard(journal)
  expect(rebuilt.list()).toEqual(board.list())
  const next = await rebuilt.create({ subject: 'c', prompt: 'p' })
  expect(next.id).toBe('task-2')
})

it('a board over the journal reopened from its file replays to identical state', async () => {
  const { board, journal } = await bootBoard()
  const a = await board.create({ subject: 'a', prompt: 'p' })
  await board.claim(a.id, 'alice', 0)
  await board.create({ subject: 'b', prompt: 'p', blockedBy: [a.id] })

  // What a new process sees: only the file, not this process's memory.
  const reopened = new SwarmBoard(SwarmJournal.open(journal.path))
  expect(reopened.list()).toEqual(board.list())
  expect((await reopened.create({ subject: 'c', prompt: 'p' })).id).toBe('task-2')
})

it('releaseOrphans frees a dead incarnation\'s claims and keeps the live ones', async () => {
  const { board, journal: first } = await bootBoard()
  const a = await board.create({ subject: 'a', prompt: 'p' })
  const b = await board.create({ subject: 'b', prompt: 'p' })
  const orphaned = await board.claim(a.id, 'alice', a.revision)
  expect(orphaned.lease).toBe(first.incarnation)

  // The lead dies; a new process opens the journal as incarnation B.
  const journal = SwarmJournal.open(first.path)
  const successor = new SwarmBoard(journal)
  const live = await successor.claim(b.id, 'carol', b.revision)
  expect(live.lease).toBe(journal.incarnation)

  const released = await successor.releaseOrphans()
  expect(released).toHaveLength(1)
  expect(released[0]).toMatchObject({ id: a.id, status: 'pending', revision: orphaned.revision + 1 })
  expect(released[0]!.owner).toBeUndefined()
  expect(released[0]!.lease).toBeUndefined()
  // The release is an appended snapshot, so it survives another reopen.
  expect(foldBoard(SwarmJournal.open(journal.path).events).get(a.id)).toEqual(released[0])
  // The current incarnation's claim is untouched...
  expect(successor.list().find((t) => t.id === b.id)).toEqual(live)
  // ...and a sibling can now claim the freed task; completing clears its lease.
  const reclaimed = await successor.claimNextReady('bob')
  expect(reclaimed).toMatchObject({ id: a.id, owner: 'bob', lease: journal.incarnation })
  const done = await successor.complete(a.id, 'bob', reclaimed!.revision)
  expect(done.lease).toBeUndefined()
  expect(await successor.releaseOrphans()).toEqual([])
})

it('runBoardWorkers releases the claim and propagates the error on member failure', async () => {
  const { runBoardWorkers } = await import('../src/topologies')
  const { board } = await bootBoard()
  const a = await board.create({ subject: 'a', prompt: 'pa' })
  const b = await board.create({ subject: 'b', prompt: 'pb' })
  const seeded = new Set([a.id, b.id])

  const boom = new Error('member exploded')
  // Task 'a' fails for EVERY member, so it exhausts its attempts and is
  // abandoned — which is loud. Termination at all proves the claim is never
  // left stuck in_progress.
  await expect(
    runBoardWorkers(
      [{ name: 'm1' }, { name: 'm2' }],
      board,
      seeded,
      async (_member, claimed) => {
        if (claimed.subject === 'a') throw boom
        return { member: _member.name, runId: 'r', output: [], text: 'ok', stopReason: 'completed' as const }
      },
    ),
  ).rejects.toThrow(/abandoned 1 task\(s\).*member exploded/)

  // The failed task was released (pending), not left stuck in_progress.
  const failed = board.list().find((t) => t.subject === 'a')!
  expect(failed.status).toBe('pending')
  expect(failed.owner).toBeUndefined()
}, 15_000)

it('waitForChange wakes on the next commit rather than on its backstop', async () => {
  const { board } = await bootBoard()
  const task = await board.create({ subject: 's', prompt: 'p' })

  const started = Date.now()
  const woke = board.waitForChange(5_000)
  // A sibling's commit is the event board workers are actually waiting for.
  await board.claim(task.id, 'worker-1', task.revision)
  await woke

  // Nowhere near the 5s backstop: this resolved on the commit itself.
  expect(Date.now() - started).toBeLessThan(1_000)
})

it('waitForChange still returns on its backstop when nothing commits', async () => {
  const { board } = await bootBoard()
  const started = Date.now()
  // The backstop exists so a worker re-checks conditions no commit announces
  // (an aborted sibling), instead of parking forever.
  await board.waitForChange(80)
  expect(Date.now() - started).toBeGreaterThanOrEqual(70)
})

it('a member dying on a task does not kill the team — a sibling finishes it', async () => {
  const { board } = await bootBoard()
  const seeded = new Set([
    (await board.create({ subject: 'a', prompt: 'p' })).id,
    (await board.create({ subject: 'b', prompt: 'p' })).id,
  ])

  const { runBoardWorkers } = await import('../src/topologies')
  // m1 dies on whatever it claims first; m2 is healthy. Before task-level
  // recovery this aborted the whole run.
  let m1Failed = false
  const runs = await runBoardWorkers(
    [{ name: 'm1' }, { name: 'm2' }],
    board,
    seeded,
    async (member, claimed) => {
      if (member.name === 'm1' && !m1Failed) {
        m1Failed = true
        throw new Error('swarm member "m1" exited before its turn completed')
      }
      return {
        member: member.name,
        runId: 'r',
        output: [],
        text: `did ${claimed.subject}`,
        stopReason: 'completed' as const,
      }
    },
  )

  // Both tasks completed, and every completion came from the survivor.
  expect(Object.keys(runs)).toHaveLength(2)
  expect(board.list().filter((t) => t.status === 'completed')).toHaveLength(2)
  expect(Object.values(runs).every((r) => r.member === 'm2')).toBe(true)
  expect(m1Failed).toBe(true)
}, 15_000)

it("a task out of attempts is asked about first; 'retry' leaves it to a sibling for one more", async () => {
  const { board } = await bootBoard()
  const task = await board.create({ subject: 'flaky', prompt: 'p' })
  const { runBoardWorkers } = await import('../src/topologies')
  const asked: { prompt: string; claimed: string | undefined }[] = []
  let failed: string | undefined
  const runs = await runBoardWorkers(
    [{ name: 'm1' }, { name: 'm2' }],
    board,
    new Set([task.id]),
    async (member, claimed) => {
      if (failed === undefined) {
        failed = member.name
        throw new Error(`${member.name} broke\nwith a trace`)
      }
      return { member: member.name, runId: 'r', output: [], text: `did ${claimed.subject}`, stopReason: 'completed' as const }
    },
    undefined,
    1,
    async (question) => {
      // Asked while the claim still holds: no sibling can start it meanwhile.
      asked.push({ prompt: question.prompt, claimed: board.list()[0]!.owner })
      expect(question).toMatchObject({ trigger: 'task-attempts', options: ['abandon', 'retry'], default: 'abandon' })
      return 'retry'
    },
  )
  expect(asked).toEqual([
    {
      prompt: `task "flaky" failed 1 of 1 allowed attempt(s), last on ${failed}: ${failed} broke with a trace. Retry it once more on a sibling, or abandon it and its dependents?`,
      claimed: failed,
    },
  ])
  expect(runs[task.id]!.member).not.toBe(failed)
  expect(board.list()[0]!.status).toBe('completed')
}, 15_000)

it('nobody is asked about a task no sibling is left to retry, and an abandoned task is never run again', async () => {
  const { runBoardWorkers } = await import('../src/topologies')
  const asked: string[] = []
  const ask = async (question: SwarmQuestionRequest) => (asked.push(question.prompt), 'abandon')
  const done = (member: MemberSpec) => ({ member: member.name, runId: 'r', output: [], text: 'ok', stopReason: 'completed' as const })

  // Two members, two attempts: the second failure is the last member's.
  const lone = await bootBoard()
  const flaky = await lone.board.create({ subject: 'flaky', prompt: 'p' })
  await expect(
    runBoardWorkers([{ name: 'm1' }, { name: 'm2' }], lone.board, new Set([flaky.id]), async (member) => {
      throw new Error(`${member.name} broke`)
    }, undefined, undefined, ask),
  ).rejects.toThrow(/abandoned 1 task/)
  expect(asked).toEqual([])

  // A member parked behind a slow task does not pick the abandoned poison back up.
  const { board } = await bootBoard()
  const poison = await board.create({ subject: 'poison', prompt: 'p' })
  const slow = await board.create({ subject: 'slow', prompt: 'p' })
  const after = await board.create({ subject: 'after', prompt: 'p', blockedBy: [slow.id] })
  const ran: string[] = []
  await expect(
    runBoardWorkers(
      [{ name: 'm1' }, { name: 'm2' }, { name: 'm3' }, { name: 'm4' }],
      board,
      new Set([poison.id, slow.id, after.id]),
      async (member, claimed) => {
        ran.push(claimed.subject)
        if (claimed.subject === 'poison') throw new Error('poison')
        if (claimed.subject === 'slow') await new Promise((resolve) => setTimeout(resolve, 300))
        return done(member)
      },
      undefined,
      undefined,
      ask,
    ),
  ).rejects.toThrow(/abandoned 1 task\(s\) — task-0: poison/)
  expect(ran.filter((subject) => subject === 'poison')).toHaveLength(2)
  expect(asked).toHaveLength(1)
  expect(board.list().map((t) => [t.subject, t.status])).toEqual([
    ['poison', 'pending'],
    ['slow', 'completed'],
    ['after', 'completed'],
  ])
}, 15_000)

it('a task blocked by an abandoned one is abandoned too, rather than parking the team', async () => {
  const { board } = await bootBoard()
  const poison = await board.create({ subject: 'poison', prompt: 'p' })
  const dependent = await board.create({ subject: 'dependent', prompt: 'p', blockedBy: [poison.id] })
  const seeded = new Set([poison.id, dependent.id])

  const { runBoardWorkers } = await import('../src/topologies')
  // `dependent` can never become ready, so without transitive abandonment the
  // surviving members would wait on it forever.
  await expect(
    runBoardWorkers([{ name: 'm1' }, { name: 'm2' }], board, seeded, async () => {
      throw new Error('always fails')
    }),
  ).rejects.toThrow(/blocked by abandoned task/)
}, 15_000)
