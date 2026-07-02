/**
 * AnthropicEnvAuth — no-op AuthSource for M0.
 *
 * The Claude Agent SDK reads env / keychain itself; we don't inject
 * credentials via headers. This impl exists so the Provider abstraction
 * stays symmetrical (RunConfig requires an AuthSource) —
 * isAuthenticated() mirrors detectAuth()'s result.
 *
 * Note: `kind` is set to "api-key" as the least-wrong label given the
 * restricted union. The actual credential source could be OAuth-derived
 * (keychain or CLAUDE_CODE_OAUTH_TOKEN), but since openswarm does not
 * own the credential we use the simpler bucket. See docs/06-open-questions.md Q16.
 */

import type { AuthSource } from "./index.js";
import { detectAuth } from "./status.js";

export class AnthropicEnvAuth implements AuthSource {
  readonly kind = "api-key" as const;
  readonly providerId = "anthropic";

  async isAuthenticated(): Promise<boolean> {
    const status = await detectAuth();
    return status.state !== "none";
  }
}
