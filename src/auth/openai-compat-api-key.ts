/**
 * OpenAICompatApiKeyAuth — generic API-key auth for OpenAI-compatible endpoints.
 *
 * Used by DashScope (DASHSCOPE_API_KEY) and any future OpenAI-compat provider.
 * The env var name and providerId are supplied at construction time.
 */

import type { AuthSource } from "./index.js";

export class OpenAICompatApiKeyAuth implements AuthSource {
  readonly kind = "api-key" as const;
  readonly providerId: string;

  constructor(private readonly envVar: string, providerId: string) {
    this.providerId = providerId;
  }

  async isAuthenticated(): Promise<boolean> {
    return !!process.env[this.envVar];
  }

  async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${process.env[this.envVar] ?? ""}`,
    };
  }
}
