/**
 * RetryingProvider — composable Provider wrapper with transport-level retry
 * and optional fallback provider.
 *
 * Maps to Codex's `try_switch_fallback_transport` (client.rs:1636-1646).
 *
 * See docs/37-hardened-engine-design.md §6.4.
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "./index.js";
import type { ProviderError } from "../core/types.js";
import type { LanguageModel } from "ai";
import {
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  isRetryableError,
  classifyProviderError,
} from "../engine/retry-policy.js";

function isRetryableTransportError(err: unknown): boolean {
  const classified = classifyProviderError(err);
  return isRetryableError(classified);
}

export class RetryingProvider implements Provider {
  readonly id: string;
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly primary: Provider,
    private readonly fallback?: Provider,
    private readonly policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {
    this.id = `retrying(${primary.id})`;
    this.model = primary.model;
    this.capabilities = primary.capabilities;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const maxRetries = this.policy.maxRetries;
    const switchToFallbackAfter = Math.ceil(maxRetries / 2);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const provider =
          attempt >= switchToFallbackAfter && this.fallback !== undefined
            ? this.fallback
            : this.primary;
        yield* provider.stream(request);
        return;
      } catch (err) {
        if (attempt === maxRetries) throw err;
        if (!isRetryableTransportError(err)) throw err;
        await new Promise((r) =>
          setTimeout(r, this.policy.backoffBaseMs * Math.pow(2, attempt)),
        );
      }
    }
  }

  preflight(request: ProviderRequest): ProviderError | null {
    return this.primary.preflight?.(request) ?? null;
  }
}
