/**
 * Single-writer lease for a shared workspace (docs/67 §A5, `WP-11`).
 *
 * Shared mode puts several agents in one working directory, each in its own
 * process. Nothing in-process can order them, so this lease lives on the
 * filesystem and is built out of the one operation the filesystem gives us for
 * free: `O_EXCL` create, which exactly one caller can win.
 *
 * Readers never take the lease. That is the design, not an omission — a shared
 * workspace is read-mostly, and blocking readers behind a writer would trade a
 * correctness problem for a throughput one. Readers instead stamp what they saw
 * with the generation current at the time, and a stamp that no longer matches is
 * what makes stale work detectable (see `read-state.ts` for the per-file half).
 *
 * Two mechanisms, doing two jobs:
 *
 *   - `holder.json`, created with `O_EXCL`, is the mutual exclusion. Whoever
 *     creates it holds the lease, and no amount of racing produces two holders.
 *   - Numbered tickets are the *fairness*. A writer only attempts the `O_EXCL`
 *     create once it holds the lowest outstanding ticket, so writers are served
 *     in arrival order instead of whoever happens to retry at the right moment.
 *
 * Splitting them this way keeps the ordering decision out of the critical
 * section: fairness is a function of directory contents, which every waiter can
 * evaluate for itself without holding anything.
 *
 * Crashed holders are the case a lockfile has to get right, because a process
 * that dies holding the lease cannot release it. Every holder writes an expiry
 * and renews it while it works; a waiter that finds an expired record removes it
 * and competes for the vacancy. Ownership is proven by a random token rather
 * than by pid, so a holder can never renew or release a lease that was already
 * taken from it — the bug that makes naive lockfiles worse than none.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Directory, under the workspace, holding the lease and the ticket queue. */
const LEASE_DIR = path.join(".openswarm", "write-lease");

/**
 * How long a lease is valid without renewal. Long enough that an ordinary hold
 * never expires mid-write, short enough that a crashed holder does not park the
 * queue for a noticeable time.
 */
export const DEFAULT_TTL_MS = 10_000;

/**
 * Hard ceiling on a single hold, renewals included. A holder that stops making
 * progress but keeps renewing is indistinguishable from one that is working, so
 * something has to bound it; without this the fairness the tickets buy could be
 * held hostage by one stuck agent.
 */
export const DEFAULT_MAX_HOLD_MS = 120_000;

/** Wait between queue checks. Jittered, so waiters do not wake in lockstep. */
const POLL_MS = 25;

interface HolderRecord {
  /** Proves ownership across renew and release. */
  readonly token: string;
  readonly ticket: number;
  readonly agentId: string;
  readonly pid: number;
  readonly acquiredAtMs: number;
  /** Wall-clock deadline after which a waiter may take the lease. */
  readonly expiresAtMs: number;
  /** Ceiling from `acquiredAtMs`; renewals cannot push past it. */
  readonly hardDeadlineMs: number;
}

/** Raised when the lease could not be acquired within the caller's budget. */
export class LeaseTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`could not acquire the write lease within ${waitedMs}ms`);
    this.name = "LeaseTimeoutError";
  }
}

/** Raised when a hold is used after it stopped being valid. */
export class LeaseLostError extends Error {
  constructor(reason: string) {
    super(`the write lease is no longer held: ${reason}`);
    this.name = "LeaseLostError";
  }
}

export interface AcquireOptions {
  /** Recorded in the lease so a stuck holder can be identified. */
  readonly agentId: string;
  readonly ttlMs?: number;
  readonly maxHoldMs?: number;
  /** Give up after this long. Absent means wait indefinitely. */
  readonly timeoutMs?: number;
  /**
   * Releases the ticket as well as abandoning the wait. A cancelled writer that
   * left its ticket behind would block everyone queued after it until the ticket
   * aged out, which is the failure this signal exists to avoid.
   */
  readonly signal?: AbortSignal;
}

/** An acquired lease. Release it in a `finally`, or the queue waits for the TTL. */
export interface WriteLease {
  readonly ticket: number;
  readonly acquiredAtMs: number;
  /** Extends the TTL. Throws `LeaseLostError` if the lease was taken away. */
  renew(): Promise<void>;
  /** Idempotent: releasing twice is not an error. */
  release(): Promise<void>;
  /** False once released, lost, or past its hard deadline. */
  readonly held: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredPoll(): number {
  return POLL_MS + Math.floor(Math.random() * POLL_MS);
}

function leasePaths(workspaceRoot: string) {
  const dir = path.join(workspaceRoot, LEASE_DIR);
  return {
    dir,
    queue: path.join(dir, "queue"),
    holder: path.join(dir, "holder.json"),
    /**
     * Monotonic ticket hint. Only ever a hint: correctness comes from the
     * `O_EXCL` create of the ticket itself, so a lost or stale counter costs a
     * retry rather than a duplicate ticket.
     */
    next: path.join(dir, "next"),
    generation: path.join(dir, "generation"),
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    // Absent, or a partial read of a record being replaced. Both mean "no
    // trustworthy holder right now", and the caller retries.
    return null;
  }
}

/** Ticket names sort lexicographically in numeric order. */
function ticketName(n: number): string {
  return String(n).padStart(12, "0");
}

async function outstandingTickets(queueDir: string): Promise<number[]> {
  try {
    const names = await fs.readdir(queueDir);
    return names
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Take a ticket. The number comes from a hint file, but the claim is the
 * `O_EXCL` create — two writers reading the same hint cannot both win, and the
 * loser simply tries the next number.
 *
 * The hint is never decreased, so a writer already waiting cannot be overtaken
 * by numbering that restarted after the queue drained.
 */
async function takeTicket(p: ReturnType<typeof leasePaths>): Promise<number> {
  await fs.mkdir(p.queue, { recursive: true });

  let candidate = 1;
  const hint = await fs
    .readFile(p.next, "utf8")
    .then((t) => Number.parseInt(t.trim(), 10))
    .catch(() => Number.NaN);
  if (Number.isFinite(hint) && hint > 0) candidate = hint;

  // An outstanding ticket at or above the hint means the hint is behind.
  const outstanding = await outstandingTickets(p.queue);
  const highest = outstanding[outstanding.length - 1];
  if (highest !== undefined && highest >= candidate) candidate = highest + 1;

  for (;;) {
    try {
      const fd = await fs.open(path.join(p.queue, ticketName(candidate)), "wx");
      await fd.close();
      // Best-effort advance. A crashed writer between the create and this line
      // only leaves the hint low, which the scan above corrects.
      await fs.writeFile(p.next, String(candidate + 1), "utf8").catch(() => {});
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      candidate += 1;
    }
  }
}

async function dropTicket(
  p: ReturnType<typeof leasePaths>,
  ticket: number,
): Promise<void> {
  await fs.rm(path.join(p.queue, ticketName(ticket)), { force: true });
}

/**
 * Remove a holder record that is no longer entitled to the lease.
 *
 * The record is re-read and compared before removal so that a holder which
 * renewed in the meantime is not evicted by a waiter acting on a stale read.
 *
 * The holder's *ticket* goes with it. A holder keeps its ticket for the whole
 * hold — that is what stops a writer from being served twice while others wait —
 * so evicting the record alone leaves the dead writer still at the head of the
 * queue, and every waiter politely waiting its turn behind a process that no
 * longer exists.
 */
async function evictIfStale(
  p: ReturnType<typeof leasePaths>,
  seen: HolderRecord,
  now: number,
): Promise<void> {
  const current = await readJson<HolderRecord>(p.holder);
  if (current === null || current.token !== seen.token) return;
  if (current.expiresAtMs > now && current.hardDeadlineMs > now) return;
  await fs.rm(p.holder, { force: true });
  await dropTicket(p, current.ticket);
}

/**
 * Acquire the workspace write lease, queueing behind writers that arrived first.
 */
export async function acquireWriteLease(
  workspaceRoot: string,
  options: AcquireOptions,
): Promise<WriteLease> {
  const p = leasePaths(workspaceRoot);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const startedMs = Date.now();

  await fs.mkdir(p.dir, { recursive: true });
  let ticket = await takeTicket(p);

  // Tracks whether the writer at the head of the queue is making progress; see
  // the presumed-dead rule in the loop below.
  let stuckHead: number | undefined;
  let stuckSinceMs = 0;

  const giveUp = async (err: Error): Promise<never> => {
    await dropTicket(p, ticket);
    throw err;
  };

  for (;;) {
    if (options.signal?.aborted === true) {
      await giveUp(new Error("write lease acquisition was cancelled"));
    }
    if (
      options.timeoutMs !== undefined &&
      Date.now() - startedMs >= options.timeoutMs
    ) {
      await giveUp(new LeaseTimeoutError(Date.now() - startedMs));
    }

    const queue = await outstandingTickets(p.queue);

    // Presumed dead, by somebody applying the rule below. Take a fresh ticket
    // rather than wait for a turn that can no longer come: with no ticket in the
    // queue this writer would never see itself at the head again.
    if (!queue.includes(ticket)) {
      ticket = await takeTicket(p);
      continue;
    }

    const ourTurn = queue[0] === ticket;

    if (ourTurn) {
      const token = crypto.randomUUID();
      const now = Date.now();
      const record: HolderRecord = {
        token,
        ticket,
        agentId: options.agentId,
        pid: process.pid,
        acquiredAtMs: now,
        expiresAtMs: now + ttlMs,
        hardDeadlineMs: now + maxHoldMs,
      };
      try {
        // The one operation that decides it. Everything above is ordering.
        const fd = await fs.open(p.holder, "wx");
        await fd.writeFile(JSON.stringify(record), "utf8");
        await fd.close();
        return makeLease(p, record, ttlMs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          await giveUp(err as Error);
        }
        // Somebody holds it. Fall through to the expiry check below.
      }
    }

    const holder = await readJson<HolderRecord>(p.holder);
    const now = Date.now();
    if (holder !== null && (holder.expiresAtMs <= now || holder.hardDeadlineMs <= now)) {
      await evictIfStale(p, holder, now);
      continue;
    }

    // A writer that took a ticket and died before claiming the lease leaves
    // nothing that can expire: there is no holder record, just a ticket at the
    // head of a queue that will never advance. Absence of a holder is not enough
    // to call it dead — the head may be a live writer a few milliseconds from
    // creating the record — so the test is that the head has failed to claim its
    // turn for longer than a whole lease would have lasted.
    const head = queue[0];
    if (holder === null && head !== undefined && head !== ticket) {
      if (stuckHead !== head) {
        stuckHead = head;
        stuckSinceMs = now;
      } else if (now - stuckSinceMs > ttlMs) {
        await dropTicket(p, head);
        stuckHead = undefined;
        continue;
      }
    } else {
      stuckHead = undefined;
    }

    await sleep(jitteredPoll());
  }
}

function makeLease(
  p: ReturnType<typeof leasePaths>,
  record: HolderRecord,
  ttlMs: number,
): WriteLease {
  let held = true;

  const stillOurs = async (): Promise<boolean> => {
    const current = await readJson<HolderRecord>(p.holder);
    return current !== null && current.token === record.token;
  };

  return {
    ticket: record.ticket,
    acquiredAtMs: record.acquiredAtMs,
    get held() {
      return held;
    },

    async renew() {
      if (!held) throw new LeaseLostError("it was already released");
      const now = Date.now();
      if (record.hardDeadlineMs <= now) {
        held = false;
        throw new LeaseLostError("the maximum hold time elapsed");
      }
      if (!(await stillOurs())) {
        held = false;
        throw new LeaseLostError("another writer took it after it expired");
      }
      // Rewritten in place under a token check rather than swapped in, because a
      // rename would clobber a record a waiter had legitimately replaced.
      const renewed: HolderRecord = {
        ...record,
        expiresAtMs: Math.min(now + ttlMs, record.hardDeadlineMs),
      };
      await fs.writeFile(p.holder, JSON.stringify(renewed), "utf8");
    },

    async release() {
      if (!held) return;
      held = false;
      // Only ever remove our own record: releasing a lease that was already
      // taken away would hand a second writer's lease to a third.
      if (await stillOurs()) {
        await fs.rm(p.holder, { force: true });
      }
      await dropTicket(p, record.ticket);
    },
  };
}

/**
 * Run `body` while holding the lease, renewing it throughout and releasing it
 * whatever happens.
 *
 * This is the form callers should use, and the renewal is why. A body that
 * outlives the TTL — any tool call that shells out, say — would otherwise have
 * its lease declared abandoned and handed to the next writer while it was still
 * writing, turning the mechanism that guarantees one writer into one that
 * quietly permits two. Asking every caller to run its own heartbeat is asking
 * for that bug.
 *
 * Renewal cannot outlast `maxHoldMs`, so a body that exceeds its bounded hold
 * still loses the lease. That case is reported rather than hidden: `body` runs to
 * completion, because there is no safe way to abandon a partial write, but the
 * caller is told the work was no longer exclusive by the time it finished.
 */
export async function withWriteLease<T>(
  workspaceRoot: string,
  options: AcquireOptions,
  body: (lease: WriteLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireWriteLease(workspaceRoot, options);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let lost: Error | undefined;

  // A third of the TTL leaves room for two missed beats before expiry.
  const heartbeat = setInterval(
    () => {
      void lease.renew().catch((err: unknown) => {
        lost ??= err instanceof Error ? err : new Error(String(err));
        clearInterval(heartbeat);
      });
    },
    Math.max(50, Math.floor(ttlMs / 3)),
  );
  // Never keep the process alive for a heartbeat.
  heartbeat.unref?.();

  try {
    const result = await body(lease);
    if (lost !== undefined) throw lost;
    return result;
  } finally {
    clearInterval(heartbeat);
    await lease.release();
  }
}

/**
 * The shared workspace generation.
 *
 * `WorkspaceAuthority` keeps a generation too, and that one counts mutations in
 * a single process — which is the wrong scope for shared mode, where each agent
 * would start its own count at one and no two would agree on what generation a
 * `ReadSet` was formed against. This counter lives beside the lease so every
 * process reads the same number.
 */
export async function readGeneration(workspaceRoot: string): Promise<number> {
  const p = leasePaths(workspaceRoot);
  try {
    const n = Number.parseInt(await fs.readFile(p.generation, "utf8"), 10);
    return Number.isFinite(n) ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * Advance the shared generation. Call while holding the lease: that is what
 * makes the read-modify-write safe without any further coordination.
 */
export async function bumpGeneration(
  workspaceRoot: string,
  lease: WriteLease,
): Promise<number> {
  if (!lease.held) {
    throw new LeaseLostError("the generation cannot be advanced without it");
  }
  const p = leasePaths(workspaceRoot);
  const next = (await readGeneration(workspaceRoot)) + 1;
  await fs.mkdir(p.dir, { recursive: true });
  await fs.writeFile(p.generation, String(next), "utf8");
  return next;
}
