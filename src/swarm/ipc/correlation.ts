/**
 * Correlation id generator for IPC requests.
 * 128-bit UUIDv4 via crypto.randomUUID() (Node 18+).
 */

import { randomUUID } from "node:crypto";

export function makeCorrelationId(): string {
  return randomUUID();
}
