import { describe, it, expect } from "vitest";
import {
  DEFAULT_RETENTION_DAYS,
  SecureKeyUnavailableError,
  isExpired,
  nullKeyProvider,
  resolveSessionStorage,
  staticKeyProvider,
} from "./storage-policy.js";
import {
  ENVELOPE_VERSION,
  EnvelopeError,
  EnvelopeTamperedError,
  createSessionKey,
  open,
  openJson,
  seal,
  sealJson,
} from "./crypto-envelope.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("session storage policy", () => {
  const key = createSessionKey("k1");
  const withKey = staticKeyProvider("test-keychain", key);

  it("defaults to encrypted 90-day retention when unconfigured", async () => {
    const resolved = await resolveSessionStorage({}, withKey);

    expect(resolved.kind).toBe("encrypted");
    if (resolved.kind !== "encrypted") return;
    expect(resolved.retention).toEqual({ kind: "days", days: DEFAULT_RETENTION_DAYS });
    expect(resolved.byDefault).toBe(true);
    expect(resolved.keyProviderId).toBe("test-keychain");
  });

  it("falls back to a warned ephemeral session when no key is available", async () => {
    // The documented no-config behaviour: ephemeral with a warning, and under
    // no circumstances plaintext history.
    const resolved = await resolveSessionStorage({}, nullKeyProvider("empty"));

    expect(resolved.kind).toBe("ephemeral");
    if (resolved.kind !== "ephemeral") return;
    expect(resolved.warning).toContain("ephemeral");
    expect(resolved.warning).toContain("empty");
  });

  it("fails closed when encryption is explicitly configured but no key exists", async () => {
    // An explicit instruction must not be silently degraded.
    await expect(
      resolveSessionStorage({ mode: "encrypted" }, nullKeyProvider("empty")),
    ).rejects.toThrow(SecureKeyUnavailableError);
  });

  it("honours an explicitly requested ephemeral session without warning", async () => {
    const resolved = await resolveSessionStorage({ mode: "ephemeral" }, withKey);

    expect(resolved.kind).toBe("ephemeral");
    if (resolved.kind !== "ephemeral") return;
    expect(resolved.warning).toBe("");
  });

  it("respects a configured retention window", async () => {
    const resolved = await resolveSessionStorage({ retentionDays: 7 }, withKey);

    if (resolved.kind !== "encrypted") throw new Error("expected encrypted");
    expect(resolved.retention).toEqual({ kind: "days", days: 7 });
    expect(resolved.byDefault).toBe(false);
  });

  it("treats a non-positive retention as unlimited", async () => {
    const resolved = await resolveSessionStorage({ retentionDays: 0 }, withKey);

    if (resolved.kind !== "encrypted") throw new Error("expected encrypted");
    expect(resolved.retention).toEqual({ kind: "forever" });
  });

  describe("retention expiry", () => {
    const now = 1_000 * MS_PER_DAY;

    it("keeps a record inside the window", () => {
      const written = now - 89 * MS_PER_DAY;
      expect(isExpired(written, { kind: "days", days: 90 }, now)).toBe(false);
    });

    it("expires a record past the window", () => {
      const written = now - 91 * MS_PER_DAY;
      expect(isExpired(written, { kind: "days", days: 90 }, now)).toBe(true);
    });

    it("never expires unlimited retention", () => {
      expect(isExpired(0, { kind: "forever" }, now)).toBe(false);
    });
  });
});

describe("sealed envelope", () => {
  const key = createSessionKey("k1");

  it("round-trips bytes", () => {
    const sealed = seal("secret text", key);
    expect(sealed.v).toBe(ENVELOPE_VERSION);
    expect(sealed.alg).toBe("aes-256-gcm");
    expect(open(sealed, key).toString("utf8")).toBe("secret text");
  });

  it("does not leave plaintext in the envelope", () => {
    const sealed = seal("AKIAIOSFODNN7EXAMPLE", key);
    expect(JSON.stringify(sealed)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("uses a fresh IV per seal", () => {
    const a = seal("same", key);
    const b = seal("same", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("round-trips JSON payloads", () => {
    const sealed = sealJson({ seq: 3, nested: { ok: true } }, key);
    expect(openJson<{ seq: number }>(sealed, key).seq).toBe(3);
  });

  describe("tamper detection", () => {
    it("rejects modified ciphertext", () => {
      const sealed = seal("secret", key);
      const ct = Buffer.from(sealed.ct, "base64");
      ct[0] = ct[0]! ^ 0xff;

      expect(() => open({ ...sealed, ct: ct.toString("base64") }, key)).toThrow(
        EnvelopeTamperedError,
      );
    });

    it("rejects a modified authentication tag", () => {
      const sealed = seal("secret", key);
      const tag = Buffer.from(sealed.tag, "base64");
      tag[0] = tag[0]! ^ 0xff;

      expect(() => open({ ...sealed, tag: tag.toString("base64") }, key)).toThrow(
        EnvelopeTamperedError,
      );
    });

    it("rejects a modified IV", () => {
      const sealed = seal("secret", key);
      const iv = Buffer.from(sealed.iv, "base64");
      iv[0] = iv[0]! ^ 0xff;

      expect(() => open({ ...sealed, iv: iv.toString("base64") }, key)).toThrow(
        EnvelopeTamperedError,
      );
    });

    it("rejects the wrong key", () => {
      const sealed = seal("secret", key);
      const other = { ...createSessionKey("k1") };
      expect(() => open(sealed, other)).toThrow(EnvelopeTamperedError);
    });

    it("rejects a key whose id does not match the envelope", () => {
      const sealed = seal("secret", key);
      expect(() => open(sealed, createSessionKey("k2"))).toThrow(/sealed with key k1/);
    });
  });

  describe("session binding", () => {
    it("opens with the matching AAD", () => {
      const sealed = seal("secret", key, "session-a");
      expect(open(sealed, key, "session-a").toString("utf8")).toBe("secret");
    });

    it("refuses an envelope replayed into another session", () => {
      const sealed = seal("secret", key, "session-a");
      expect(() => open(sealed, key, "session-b")).toThrow(EnvelopeTamperedError);
    });

    it("refuses to open a bound envelope without the binding", () => {
      const sealed = seal("secret", key, "session-a");
      expect(() => open(sealed, key)).toThrow(EnvelopeTamperedError);
    });
  });

  describe("version and algorithm guards", () => {
    it("refuses an envelope newer than this reader", () => {
      const sealed = seal("secret", key);
      expect(() => open({ ...sealed, v: ENVELOPE_VERSION + 1 }, key)).toThrow(
        /newer than this reader/,
      );
    });

    it("refuses an unknown algorithm", () => {
      const sealed = seal("secret", key);
      expect(() =>
        open({ ...sealed, alg: "rot13" as unknown as typeof sealed.alg }, key),
      ).toThrow(EnvelopeError);
    });

    it("refuses a key of the wrong length", () => {
      expect(() => seal("secret", { keyId: "short", material: Buffer.alloc(8) })).toThrow(
        /must be 32 bytes/,
      );
    });
  });
});
