/**
 * The member-harness concurrency cap (docs/01 ledger: "a 50-task fanout spawns
 * 50 member harnesses"). `Slots` is exported from the module for this test but
 * not re-exported by the package index — it is internal machinery, and what
 * matters is that it never lets more than `limit` runs be in flight and never
 * strands a queued one.
 */
import { expect, it } from 'vitest'
import { Slots } from '../src/worktrees'

/** Run `count` tasks through the semaphore, recording peak concurrency. */
async function saturate(limit: number, count: number) {
  const slots = new Slots(limit)
  let active = 0
  let peak = 0
  const order: number[] = []
  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      await slots.acquire()
      active++
      peak = Math.max(peak, active)
      // Yield so every holder overlaps as much as the cap allows.
      await new Promise((r) => setTimeout(r, 1))
      order.push(i)
      active--
      slots.release()
    }),
  )
  return { peak, order }
}

it('caps concurrent runs and still completes every one', async () => {
  const { peak, order } = await saturate(3, 20)
  expect(peak).toBe(3)
  expect(order).toHaveLength(20)
  expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
})

it('a limit of 1 serializes', async () => {
  const { peak } = await saturate(1, 5)
  expect(peak).toBe(1)
})

it('a limit above the task count never blocks', async () => {
  const { peak } = await saturate(10, 4)
  expect(peak).toBe(4)
})

it('release hands its slot to the next waiter rather than dropping it', async () => {
  const slots = new Slots(1)
  await slots.acquire()
  let second = false
  const queued = slots.acquire().then(() => (second = true))
  // Still held: the waiter must not have been admitted.
  await new Promise((r) => setTimeout(r, 5))
  expect(second).toBe(false)
  slots.release()
  await queued
  expect(second).toBe(true)
  // The handed-over slot is still accounted for: a third caller waits until
  // the second releases, rather than slipping in on a leaked count.
  let third = false
  const last = slots.acquire().then(() => (third = true))
  await new Promise((r) => setTimeout(r, 5))
  expect(third).toBe(false)
  slots.release()
  await last
  expect(third).toBe(true)
})
