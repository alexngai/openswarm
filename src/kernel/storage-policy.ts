/**
 * Session storage policy (docs/63 locked decisions, WP-00).
 *
 * The rule this encodes: storage is configurable, but with no configuration
 * OpenSwarm keeps full encrypted history for 90 days, and if no secure key
 * provider is available it runs an ephemeral session with a clear warning
 * instead of ever writing plaintext.
 *
 * Plaintext is deliberately not representable in `ResolvedStorage`. A silent
 * downgrade to unencrypted history is the failure mode worth designing out, so
 * there is no variant to downgrade *to* — the only alternatives to encrypted
 * durable storage are an explicit ephemeral session or a raised error.
 */

import type { SessionKey } from "./crypto-envelope.js";

/** Retention with no configuration, in days. */
export const DEFAULT_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Supplies the key that encrypts durable session state — an OS keychain, or a
 * configured headless key. Returning null means "unavailable", which is a
 * routine condition (a container with no keychain) rather than an error.
 */
export interface SecureKeyProvider {
  /** Identifies the provider in warnings and diagnostics. */
  readonly id: string;
  getKey(): Promise<SessionKey | null>;
}

export interface SessionStorageConfig {
  /**
   * Absent means unconfigured, which selects the encrypted 90-day default when
   * a key exists. Setting it explicitly is a user decision and is honoured
   * strictly: `encrypted` fails closed rather than degrading.
   */
  readonly mode?: "encrypted" | "ephemeral";
  /** Overrides the default; ignored for an ephemeral session. */
  readonly retentionDays?: number;
}

export type Retention =
  | { readonly kind: "days"; readonly days: number }
  | { readonly kind: "forever" };

export type ResolvedStorage =
  | {
      readonly kind: "encrypted";
      readonly key: SessionKey;
      readonly keyProviderId: string;
      readonly retention: Retention;
      /** True when this came from the default rather than explicit config. */
      readonly byDefault: boolean;
    }
  | {
      readonly kind: "ephemeral";
      /** Shown to the user; empty when ephemeral was explicitly requested. */
      readonly warning: string;
    };

/** Raised when configuration demands durable encryption and no key exists. */
export class SecureKeyUnavailableError extends Error {
  constructor(readonly providerId: string) {
    super(
      `session storage is configured as encrypted but key provider ${providerId} ` +
        `returned no key; refusing to continue rather than storing history unencrypted`,
    );
    this.name = "SecureKeyUnavailableError";
  }
}

/**
 * Chooses a storage mode.
 *
 * - explicit `ephemeral` → ephemeral, no warning (the user asked for it)
 * - explicit `encrypted` with no key → throws, because degrading would violate
 *   an explicit instruction
 * - unconfigured with a key → encrypted, 90-day retention
 * - unconfigured with no key → ephemeral plus a warning, never plaintext
 */
export async function resolveSessionStorage(
  config: SessionStorageConfig,
  provider: SecureKeyProvider,
): Promise<ResolvedStorage> {
  if (config.mode === "ephemeral") {
    return { kind: "ephemeral", warning: "" };
  }

  const key = await provider.getKey();

  if (key === null) {
    if (config.mode === "encrypted") {
      throw new SecureKeyUnavailableError(provider.id);
    }
    return {
      kind: "ephemeral",
      warning:
        `No secure key available from ${provider.id}. This session is ephemeral: ` +
        `history will not be written to disk. Configure a key provider to keep ` +
        `encrypted history.`,
    };
  }

  return {
    kind: "encrypted",
    key,
    keyProviderId: provider.id,
    retention: resolveRetention(config),
    byDefault: config.mode === undefined && config.retentionDays === undefined,
  };
}

function resolveRetention(config: SessionStorageConfig): Retention {
  const days = config.retentionDays;
  if (days === undefined) return { kind: "days", days: DEFAULT_RETENTION_DAYS };
  if (days <= 0) return { kind: "forever" };
  return { kind: "days", days };
}

/** Whether a record written at `writtenAtMs` is now past its retention. */
export function isExpired(writtenAtMs: number, retention: Retention, nowMs: number): boolean {
  if (retention.kind === "forever") return false;
  return nowMs - writtenAtMs > retention.days * MS_PER_DAY;
}

/** In-memory provider for tests and for an explicitly keyless environment. */
export function nullKeyProvider(id = "none"): SecureKeyProvider {
  return { id, getKey: async () => null };
}

export function staticKeyProvider(id: string, key: SessionKey): SecureKeyProvider {
  return { id, getKey: async () => key };
}
