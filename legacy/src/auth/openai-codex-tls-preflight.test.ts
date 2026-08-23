import { describe, it, expect, vi } from "vitest";
import { runCodexTlsPreflight, formatCodexTlsFix } from "./openai-codex-tls-preflight.js";

function certError(code: string): Error {
  // Mirror the shape Node throws: an Error whose `cause` carries the TLS code.
  return Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code }) });
}

describe("runCodexTlsPreflight", () => {
  it("ok when the probe resolves (handshake succeeded)", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 302 }) as unknown as Response) as unknown as typeof fetch;
    expect(await runCodexTlsPreflight({ fetchImpl })).toEqual({ ok: true });
  });

  it("classifies a TLS cert error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw certError("SELF_SIGNED_CERT_IN_CHAIN");
    }) as unknown as typeof fetch;
    const r = await runCodexTlsPreflight({ fetchImpl });
    expect(r).toMatchObject({ ok: false, kind: "tls-cert", code: "SELF_SIGNED_CERT_IN_CHAIN" });
  });

  it("classifies a cert error by message when no code is present", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("unable to get local issuer certificate");
    }) as unknown as typeof fetch;
    expect((await runCodexTlsPreflight({ fetchImpl })) as { kind: string }).toMatchObject({ kind: "tls-cert" });
  });

  it("classifies a timeout/abort as network (not a cert issue)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect((await runCodexTlsPreflight({ fetchImpl })) as { kind: string }).toMatchObject({ kind: "network" });
  });

  it("classifies a non-TLS failure as network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    }) as unknown as typeof fetch;
    expect((await runCodexTlsPreflight({ fetchImpl })) as { kind: string }).toMatchObject({ kind: "network" });
  });
});

describe("formatCodexTlsFix", () => {
  it("gives brew fix hints for cert failures", () => {
    const msg = formatCodexTlsFix({ ok: false, kind: "tls-cert", code: "CERT_HAS_EXPIRED", message: "x" });
    expect(msg).toContain("brew postinstall ca-certificates");
    expect(msg).toContain("openssl@3");
  });

  it("gives a network message for non-cert failures", () => {
    const msg = formatCodexTlsFix({ ok: false, kind: "network", message: "ENOTFOUND" });
    expect(msg).toContain("network error");
    expect(msg).not.toContain("brew");
  });
});
