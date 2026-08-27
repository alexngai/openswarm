/**
 * OpenAIEnvAuth — reads OPENAI_API_KEY from the environment.
 *
 * This is the simplest auth source: no refresh, no keychain, just an env var.
 * The OpenAITransportProvider.create() factory checks isAuthenticated() before
 * constructing the provider and throws a user-facing error when missing; the
 * transport itself reads OPENAI_API_KEY directly for the outbound header.
 */

import type { AuthSource } from "./index.js";

export class OpenAIEnvAuth implements AuthSource {
  readonly kind = "api-key" as const;
  readonly providerId = "openai";

  async isAuthenticated(): Promise<boolean> {
    return !!process.env["OPENAI_API_KEY"];
  }
}
