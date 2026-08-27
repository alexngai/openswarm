/**
 * Header builder for codex Responses requests.
 *
 * The exact set the backend expects (docs/42 §5). `originator: "openswarm"`
 * was confirmed accepted by the live spike — the field is not allowlisted.
 */

export interface CodexHeaderParams {
  readonly token: string;
  readonly accountId: string;
  /** Stable per-session id → cache affinity + request correlation. */
  readonly sessionId: string;
  readonly userAgent?: string;
}

export function buildCodexHeaders(p: CodexHeaderParams): Record<string, string> {
  return {
    Authorization: `Bearer ${p.token}`,
    "chatgpt-account-id": p.accountId,
    originator: "openswarm",
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
    session_id: p.sessionId,
    "x-client-request-id": p.sessionId,
    "User-Agent": p.userAgent ?? "openswarm",
  };
}
