/**
 * WorkerPool — concurrency-capping semaphore with FIFO queue and graceful drain.
 *
 * Used by the Orchestrator (Phase 5) to cap the number of simultaneously
 * running workers. No external dependencies; ~70 LOC.
 *
 * Usage:
 *   const pool = new WorkerPool(3);
 *   const token = await pool.acquire();
 *   try { await doWork(); } finally { token.release(); }
 */

export interface PoolToken {
  /** Release the slot. Idempotent — subsequent calls are no-ops. */
  release(): void;
}

export class WorkerPool {
  private readonly _concurrency: number;
  private _active = 0;
  private _closed = false;

  /** FIFO queue of pending acquire resolvers. */
  private readonly _queue: Array<{
    resolve: (token: PoolToken) => void;
    reject: (err: Error) => void;
  }> = [];

  /** Pending drain promises — resolved when _active reaches 0 and queue is empty. */
  private readonly _drainWaiters: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    if (maxConcurrency < 1) {
      throw new Error(
        `WorkerPool: maxConcurrency must be >= 1, got ${maxConcurrency}`,
      );
    }
    this._concurrency = maxConcurrency;
  }

  /** Number of currently active (unreleased) tokens. Live accessor. */
  get activeCount(): number {
    return this._active;
  }

  /** Maximum concurrency this pool was created with. */
  get concurrency(): number {
    return this._concurrency;
  }

  /**
   * Acquire a concurrency slot. If the pool is at capacity, the returned
   * promise is queued FIFO and resolves when a slot opens.
   *
   * Throws if the pool has been closed.
   */
  acquire(): Promise<PoolToken> {
    if (this._closed) {
      return Promise.reject(new Error("WorkerPool: pool is closed"));
    }

    if (this._active < this._concurrency) {
      this._active++;
      return Promise.resolve(this._makeToken());
    }

    // At capacity — queue this acquire.
    return new Promise<PoolToken>((resolve, reject) => {
      this._queue.push({ resolve, reject });
    });
  }

  /**
   * Wait until all outstanding tokens are released and the queue is empty.
   * Does NOT prevent new acquires — close the pool first for shutdown.
   */
  drain(): Promise<void> {
    if (this._active === 0 && this._queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._drainWaiters.push(resolve);
    });
  }

  /**
   * Reject all pending (queued) acquires. Subsequent acquires also throw.
   * Existing outstanding tokens are unaffected — callers must still release.
   */
  close(): void {
    this._closed = true;
    // Drain the pending queue, rejecting each waiter.
    while (this._queue.length > 0) {
      const waiter = this._queue.shift()!;
      waiter.reject(new Error("WorkerPool: pool closed while waiting for slot"));
    }
  }

  private _makeToken(): PoolToken {
    let released = false;
    return {
      release: () => {
        if (released) {
          // Idempotent: double-release is a no-op.
          process.stderr.write(
            "WorkerPool: warning — token released more than once (no-op)\n",
          );
          return;
        }
        released = true;
        this._release();
      },
    };
  }

  private _release(): void {
    if (this._queue.length > 0) {
      // Hand the slot directly to the next waiter.
      const next = this._queue.shift()!;
      // _active stays the same: one leaves, one enters.
      next.resolve(this._makeToken());
    } else {
      this._active--;
      this._checkDrain();
    }
  }

  private _checkDrain(): void {
    if (this._active === 0 && this._queue.length === 0) {
      while (this._drainWaiters.length > 0) {
        this._drainWaiters.shift()!();
      }
    }
  }
}
