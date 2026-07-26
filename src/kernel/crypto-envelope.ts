/**
 * Sealed storage envelope (docs/63 WP-00, WP-27).
 *
 * Session history, attachments, and journal payloads are stored inside this
 * envelope so that "encrypted by default" is a property of the format rather
 * than of the code path that happens to write it.
 *
 * AES-256-GCM is authenticated, so tampering is detectable rather than merely
 * unlikely: a modified ciphertext, IV, or tag fails to open instead of yielding
 * plausible-looking bytes. Callers bind an envelope to its session through the
 * AAD, which stops an envelope from being replayed into a different session
 * where its contents would be read under the wrong identity.
 *
 * The version field exists so a future algorithm change can be read by the
 * release that introduces it and the one before (docs/63 §A9).
 */

import * as crypto from "node:crypto";

export const ENVELOPE_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** A 256-bit session key plus the identifier of the provider that vended it. */
export interface SessionKey {
  readonly keyId: string;
  readonly material: Buffer;
}

export interface SealedEnvelope {
  readonly v: number;
  readonly alg: typeof ALGORITHM;
  /** Identifies which key opens this envelope, so rotation stays readable. */
  readonly keyId: string;
  /** base64 */
  readonly iv: string;
  /** base64 GCM authentication tag */
  readonly tag: string;
  /** base64 ciphertext */
  readonly ct: string;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Raised when an envelope fails authentication or is otherwise unusable. */
export class EnvelopeTamperedError extends EnvelopeError {
  constructor(detail: string) {
    super(`sealed envelope failed authentication: ${detail}`);
    this.name = "EnvelopeTamperedError";
  }
}

export function createSessionKey(keyId: string): SessionKey {
  return { keyId, material: crypto.randomBytes(KEY_BYTES) };
}

function assertKey(key: SessionKey): void {
  if (key.material.byteLength !== KEY_BYTES) {
    throw new EnvelopeError(
      `session key must be ${KEY_BYTES} bytes, got ${key.material.byteLength}`,
    );
  }
}

/**
 * Seals bytes. `aad` is authenticated but not encrypted; pass the session id so
 * the envelope cannot be opened as part of another session.
 */
export function seal(plaintext: Buffer | string, key: SessionKey, aad?: string): SealedEnvelope {
  assertKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key.material, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));

  const body = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);

  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    keyId: key.keyId,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

/** Opens a sealed envelope, or throws. Never returns partial plaintext. */
export function open(envelope: SealedEnvelope, key: SessionKey, aad?: string): Buffer {
  assertKey(key);

  if (envelope.v > ENVELOPE_VERSION) {
    throw new EnvelopeError(
      `envelope version ${envelope.v} is newer than this reader (${ENVELOPE_VERSION})`,
    );
  }
  if (envelope.alg !== ALGORITHM) {
    throw new EnvelopeError(`unsupported envelope algorithm ${String(envelope.alg)}`);
  }
  if (envelope.keyId !== key.keyId) {
    throw new EnvelopeError(
      `envelope was sealed with key ${envelope.keyId}, not ${key.keyId}`,
    );
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key.material,
      Buffer.from(envelope.iv, "base64"),
    );
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, "base64")),
      decipher.final(),
    ]);
  } catch (err) {
    // GCM verification failure and malformed inputs are both "do not trust
    // these bytes", and are reported identically so nothing leaks about which.
    throw new EnvelopeTamperedError(err instanceof Error ? err.message : String(err));
  }
}

/** Convenience for JSON payloads, which is what the journal stores. */
export function sealJson(value: unknown, key: SessionKey, aad?: string): SealedEnvelope {
  return seal(JSON.stringify(value), key, aad);
}

export function openJson<T>(envelope: SealedEnvelope, key: SessionKey, aad?: string): T {
  return JSON.parse(open(envelope, key, aad).toString("utf8")) as T;
}
