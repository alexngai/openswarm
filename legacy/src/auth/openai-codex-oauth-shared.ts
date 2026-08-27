/**
 * Shared constants + token exchange/refresh for the codex (ChatGPT) OAuth flow.
 *
 * We authenticate as the official Codex client (reusing its client id) so the
 * ChatGPT-subscription entitlement applies — this is the sanctioned-for-now
 * pathway (docs/42 Q5), deliberately isolated so it can be disabled if OpenAI's
 * ToS changes. Ported from opencode `plugin/codex.ts`.
 */

import { resolveCodexIdentity } from "./openai-codex-jwt.js";
import type { CodexTokens } from "./openai-codex-token-store.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_REDIRECT_PORT}/auth/callback`;
export const CODEX_SCOPE = "openid profile email offline_access";

export interface TokenResponse {
  readonly id_token?: string;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in?: number;
}

async function postForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs = 10_000,
): Promise<TokenResponse> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    // Bound the token POST so a hung/tarpitting endpoint can't wedge a refresh
    // (and, via it, `doctor` or any turn that refreshes).
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Surface only the structured OAuth error fields — never the raw body, which
    // on the refresh path travels with the refresh token and could be echoed.
    const raw = await res.text().catch(() => "");
    let detail = "";
    try {
      const j = JSON.parse(raw) as { error?: unknown; error_description?: unknown };
      detail = [j.error, j.error_description].filter((v): v is string => typeof v === "string").join(": ");
    } catch {
      /* non-JSON body — omit entirely */
    }
    throw new Error(`codex token request failed: ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  const json = (await res.json()) as TokenResponse;
  if (!json || typeof json.access_token !== "string") {
    throw new Error("codex token response missing access_token");
  }
  return json;
}

export function exchangeCodeForTokens(
  params: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postForm(
    CODEX_TOKEN_URL,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    },
    fetchImpl,
  );
}

export function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postForm(
    CODEX_TOKEN_URL,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    },
    fetchImpl,
  );
}

/**
 * Normalize an OAuth token response into the stored shape. Account id + expiry
 * come from the access-token JWT; falls back to `expires_in` when the JWT omits
 * `exp`. `refresh_token` may be absent on refresh responses — caller supplies
 * the prior one in that case.
 */
export function tokensToStored(
  tr: TokenResponse,
  now: number,
  fallbackRefresh?: string,
): CodexTokens {
  const identity = resolveCodexIdentity(tr.access_token);
  const refresh = tr.refresh_token || fallbackRefresh || "";
  const expiresAt = identity.expiresAt ?? now + (tr.expires_in ?? 3600) * 1000;
  return {
    access: tr.access_token,
    refresh,
    accountId: identity.accountId ?? "",
    expiresAt,
  };
}
