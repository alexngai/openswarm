/**
 * TLS preflight for codex (ChatGPT) OAuth.
 *
 * Homebrew Node/OpenSSL on macOS frequently cannot validate auth.openai.com's
 * certificate chain (missing CA bundle), which makes the OAuth browser flow
 * fail with an opaque error. Probe ahead of time and emit actionable fix hints.
 * Ported from openclaw `src/plugins/provider-openai-chatgpt-oauth-tls.ts`.
 *
 * Pure logic + an injectable fetch — unit-testable without real network.
 */

import * as path from "node:path";

const TLS_CERT_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const TLS_CERT_ERROR_PATTERNS = [
  /unable to get local issuer certificate/i,
  /unable to verify the first certificate/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
];

const PROBE_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openswarm-preflight" +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid";

export type TlsPreflightResult =
  | { ok: true }
  | { ok: false; kind: "tls-cert" | "network"; code?: string; message: string };

function extractFailure(error: unknown): {
  code?: string;
  message: string;
  kind: "tls-cert" | "network";
} {
  const root = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  const cause = root?.cause as { code?: unknown; message?: unknown } | undefined;
  const code =
    typeof cause?.code === "string"
      ? cause.code
      : typeof root?.code === "string"
        ? root.code
        : undefined;
  const message =
    typeof cause?.message === "string"
      ? cause.message
      : typeof root?.message === "string"
        ? root.message
        : String(error);
  const isTlsCert =
    (code ? TLS_CERT_ERROR_CODES.has(code) : false) ||
    TLS_CERT_ERROR_PATTERNS.some((p) => p.test(message));
  return { code, message, kind: isTlsCert ? "tls-cert" : "network" };
}

export async function runCodexTlsPreflight(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TlsPreflightResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 4000;
  try {
    // A reachable endpoint (even a 3xx/4xx) means TLS validated — we only care
    // that the handshake succeeded, so `redirect: "manual"` avoids following.
    await fetchImpl(PROBE_URL, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true };
  } catch (error) {
    const f = extractFailure(error);
    return { ok: false, kind: f.kind, ...(f.code !== undefined ? { code: f.code } : {}), message: f.message };
  }
}

function homebrewCertBundlePath(): string | null {
  const marker = `${path.sep}Cellar${path.sep}`;
  const idx = process.execPath.indexOf(marker);
  const prefix =
    idx > 0 ? process.execPath.slice(0, idx) : process.env.HOMEBREW_PREFIX?.trim() || null;
  return prefix ? path.join(prefix, "etc", "openssl@3", "cert.pem") : null;
}

export function formatCodexTlsFix(result: Exclude<TlsPreflightResult, { ok: true }>): string {
  if (result.kind !== "tls-cert") {
    return `network error reaching auth.openai.com: ${result.message} (check DNS/firewall/proxy)`;
  }
  const lines = [
    "Node/OpenSSL cannot validate auth.openai.com's TLS certificate.",
    `Cause: ${result.code ? `${result.code} (${result.message})` : result.message}`,
    "Fix (Homebrew Node/OpenSSL): brew postinstall ca-certificates && brew postinstall openssl@3",
  ];
  const bundle = homebrewCertBundlePath();
  if (bundle) lines.push(`Verify cert bundle exists: ${bundle}`);
  return lines.join(" ");
}
