/**
 * GoogleApiKeyAuth — reads GOOGLE_GENERATIVE_AI_API_KEY from the environment.
 */

import type { AuthSource } from "./index.js";

export class GoogleApiKeyAuth implements AuthSource {
  readonly kind = "api-key" as const;
  readonly providerId = "google";

  async isAuthenticated(): Promise<boolean> {
    return !!process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  }

  async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? ""}`,
    };
  }
}
