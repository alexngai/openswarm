/**
 * XaiApiKeyAuth — reads XAI_API_KEY from the environment.
 */

import type { AuthSource } from "./index.js";

export class XaiApiKeyAuth implements AuthSource {
  readonly kind = "api-key" as const;
  readonly providerId = "xai";

  async isAuthenticated(): Promise<boolean> {
    return !!process.env["XAI_API_KEY"];
  }
}
