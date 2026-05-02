/**
 * AuthSource — how credentials are supplied to a Provider.
 *
 * Orthogonal to Provider (docs/03-interfaces.md §1b): the same provider can
 * accept multiple AuthSource implementations. A TransportProvider calls
 * `headers()` before each request to merge auth headers into the outbound call.
 *
 * OAuth tokens live in `~/.swarm-harness/auth.json`, encrypted at rest where the
 * platform supports it. Never write tokens to session logs or git.
 */

export type AuthKind = "api-key" | "oauth-bearer";

export interface AuthSource {
  readonly kind: AuthKind;
  /** Provider this auth is scoped to: "anthropic" | "openai" | "google" | "xai". */
  readonly providerId: string;

  /**
   * Called before each request. Returns headers to merge into the outbound call.
   *
   * - `api-key`: returns `{ "x-api-key": ... }` or `{ Authorization: "Bearer ..." }`
   *   depending on provider wire format.
   * - `oauth-bearer`: returns `{ Authorization: "Bearer ..." }` and any required
   *   companion headers. Some engines (Agent SDK) may handle the OAuth flow
   *   internally; in that case the AuthSource returns `{}` and the engine
   *   reads its own persisted credentials.
   *
   * Implementations are expected to refresh expired tokens transparently.
   */
  headers(): Promise<Record<string, string>>;

  /**
   * Force a credential refresh. Only meaningful for `oauth-bearer` implementations.
   * Returns the fresh credential; throws if refresh is impossible (user must re-auth).
   */
  refresh?(): Promise<void>;

  /**
   * True if this auth source currently has valid credentials on disk / in memory.
   * Used by `doctor` and by login flows to short-circuit when already authed.
   */
  isAuthenticated(): Promise<boolean>;
}

/**
 * Interactive login flow — POST-M0 scope.
 *
 * M0 does not implement interactive auth. Users run `claude auth login` themselves
 * (Anthropic's CLI) and swarm-harness inherits credentials from env / keychain.
 * See docs/06-open-questions.md Q16 for the decision rationale.
 *
 * This interface stays here for symmetry; implementations arrive with future
 * milestones if we ever own an OAuth flow.
 */
export interface InteractiveAuth extends AuthSource {
  readonly kind: "oauth-bearer";

  /**
   * Runs the interactive OAuth flow (browser + loopback callback), persists
   * the resulting token, and returns once credentials are ready.
   * Throws on cancellation or flow error.
   */
  login(options?: { readonly deviceCode?: boolean }): Promise<void>;

  /** Revoke + delete persisted credentials. */
  logout(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Concrete auth sources — see docs/03-interfaces.md §1b table.
// Implementations live in sibling files; this module only exports the interface.
//
//   AnthropicApiKeyAuth   — M0
//   AnthropicOAuthAuth    — M3 (framework-managed; delegates to Agent SDK)
//   OpenAIApiKeyAuth      — M2
//   GoogleApiKeyAuth      — M4
//   XaiApiKeyAuth         — M4
//   OpenAICompatApiKeyAuth — M2 (Ollama / LM Studio / OpenRouter)
//
// Removed in v0.3 (was M4 Codex App Server OAuth):
//   OpenAIOAuthAuth — Codex App Server now delegates auth to `codex login`
//                    via the codex-chatgpt FrameworkProvider; swarm-harness
//                    owns zero OAuth code for this provider.
// ---------------------------------------------------------------------------
