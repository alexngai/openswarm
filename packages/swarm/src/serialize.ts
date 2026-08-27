/**
 * Serializer — runs async operations one at a time in submission order.
 *
 * The board and the mailbox both mutate the durable session log through a
 * read-check-append sequence that must not interleave; each owns a Serializer
 * and routes its mutations through `run()`. Errors are isolated: a rejecting
 * operation rejects only its own caller's promise, and the next queued
 * operation still runs.
 */
export class Serializer {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
