/**
 * Decode ChatGPT/codex OAuth identity from the access-token JWT.
 *
 * The codex access token is a JWT whose claims carry the account id, plan, and
 * expiry we need for request headers and silent refresh (docs/42 §5). Ported
 * from openclaw `extensions/openai/openai-chatgpt-auth-identity.ts`.
 *
 * Pure — no I/O. Never logs token contents.
 */

interface CodexJwtClaims {
  exp?: unknown;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: unknown;
    chatgpt_plan_type?: unknown;
  };
  "https://api.openai.com/profile"?: { email?: unknown };
}

export interface CodexIdentity {
  readonly accountId?: string;
  readonly planType?: string;
  readonly email?: string;
  /** Epoch ms when the access token expires (from `exp`), if present. */
  readonly expiresAt?: number;
}

function trimNonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function decodeClaims(accessToken: string): CodexJwtClaims | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as CodexJwtClaims) : null;
  } catch {
    return null;
  }
}

export function resolveCodexIdentity(accessToken: string): CodexIdentity {
  const claims = decodeClaims(accessToken);
  const auth = claims?.["https://api.openai.com/auth"];
  const exp = typeof claims?.exp === "number" && claims.exp > 0 ? Math.trunc(claims.exp) : undefined;
  return {
    ...(trimNonEmpty(auth?.chatgpt_account_id) !== undefined
      ? { accountId: trimNonEmpty(auth?.chatgpt_account_id) }
      : {}),
    ...(trimNonEmpty(auth?.chatgpt_plan_type) !== undefined
      ? { planType: trimNonEmpty(auth?.chatgpt_plan_type) }
      : {}),
    ...(trimNonEmpty(claims?.["https://api.openai.com/profile"]?.email) !== undefined
      ? { email: trimNonEmpty(claims?.["https://api.openai.com/profile"]?.email) }
      : {}),
    ...(exp !== undefined ? { expiresAt: exp * 1000 } : {}),
  };
}

/** Convenience: epoch-ms expiry from the access token, or undefined. */
export function resolveCodexExpiry(accessToken: string): number | undefined {
  return resolveCodexIdentity(accessToken).expiresAt;
}
