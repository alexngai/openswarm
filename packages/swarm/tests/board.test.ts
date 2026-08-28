import { afterEach, expect, it } from 'vitest'
import { SwarmBoard, SwarmBoardError, foldBoard } from '../src/board'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function bootBoard() {
  // The mock LLM is unused by board tests; the harness supplies the real
  // session store, persistence, and a live lead agent to own the log.
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  return { board: h.swarm.board(h.lead.agent), lead: h.lead.agent }
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
  expect(await board.claimNextReady('bob')).toMatchObject({ id: t.id, owner: 'bob' })
})

it('board state is a pure fold of the lead session log', async () => {
  const { board, lead } = await bootBoard()
  const a = await board.create({ subject: 'a', prompt: 'p' })
  await board.claim(a.id, 'alice', 0)
  await board.complete(a.id, 'alice', 1, 'r')
  await board.create({ subject: 'b', prompt: 'p' })

  // Replaying the raw log reproduces the board...
  const folded = foldBoard(lead.session.events)
  expect([...folded.values()]).toEqual(board.list())
  // ...and a fresh board over the same session sees identical state and
  // continues the id sequence instead of reusing task ids.
  const rebuilt = new SwarmBoard((h as any).ctx, lead)
  expect(rebuilt.list()).toEqual(board.list())
  const next = await rebuilt.create({ subject: 'c', prompt: 'p' })
  expect(next.id).toBe('task-2')
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
