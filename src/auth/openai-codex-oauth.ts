/**
 * OpenAICodexAuth — credential source for the codex (ChatGPT-subscription)
 * provider.
 *
 * Implements:
 *   - AuthSource / InteractiveAuth (the generic auth seam: headers, login,
 *     logout, refresh, isAuthenticated)
 *   - CodexCredentialSource (the codex provider's getCredentials)
 *
 * Owns silent refresh: getCredentials() refreshes the access token via the
 * stored refresh token when it is within REFRESH_BUFFER of expiry, then
 * rewrites the token store. Tokens never hit logs.
 */

import type { InteractiveAuth } from "./index.js";
import type { CodexCredentialSource } from "../providers/codex-responses/index.js";
import {
  readCodexTokens,
  writeCodexTokens,
  clearCodexTokens,
  type CodexTokens,
} from "./openai-codex-token-store.js";
import { refreshAccessToken, tokensToStored } from "./openai-codex-oauth-shared.js";
import { runBrowserOAuth } from "./openai-codex-pkce.js";
import { runDeviceOAuth } from "./openai-codex-device.js";

const REFRESH_BUFFER_MS = 60_000;

export interface OpenAICodexAuthOptions {
  /** Token-store base dir (tests). Defaults to ~/.swarm-harness. */
  readonly baseDir?: string;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class OpenAICodexAuth implements InteractiveAuth, CodexCredentialSource {
  readonly kind = "oauth-bearer" as const;
  readonly providerId = "openai";

  private readonly baseDir?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: OpenAICodexAuthOptions = {}) {
    this.baseDir = opts.baseDir;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Provider-facing: fresh bearer + account id, refreshing if near expiry. */
  async getCredentials(): Promise<{ token: string; accountId: string }> {
    const tokens = await this.validTokens();
    return { token: tokens.access, accountId: tokens.accountId };
  }

  /** AuthSource: headers to merge into the outbound request. */
  async headers(): Promise<Record<string, string>> {
    const { token, accountId } = await this.getCredentials();
    return { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId };
  }

  async isAuthenticated(): Promise<boolean> {
    const t = readCodexTokens(this.baseDir);
    return t !== null && t.refresh !== "";
  }

  async refresh(): Promise<void> {
    const stored = readCodexTokens(this.baseDir);
    if (stored === null) {
      throw new Error("not authenticated — run `swarm-harness login --provider openai-codex`");
    }
    await this.doRefresh(stored);
  }

  async login(options?: { readonly deviceCode?: boolean }): Promise<void> {
    const tr = options?.deviceCode
      ? await runDeviceOAuth({ fetchImpl: this.fetchImpl })
      : await runBrowserOAuth({ fetchImpl: this.fetchImpl });
    const stored = tokensToStored(tr, this.now());
    if (stored.accountId === "") {
      throw new Error("login succeeded but no ChatGPT account id was found in the token");
    }
    writeCodexTokens(stored, this.baseDir);
  }

  async logout(): Promise<void> {
    clearCodexTokens(this.baseDir);
  }

  // -------------------------------------------------------------------------

  private async validTokens(): Promise<CodexTokens> {
    const stored = readCodexTokens(this.baseDir);
    if (stored === null) {
      throw new Error("not authenticated — run `swarm-harness login --provider openai-codex`");
    }
    if (stored.expiresAt - this.now() > REFRESH_BUFFER_MS) {
      return stored;
    }
    return this.doRefresh(stored);
  }

  private async doRefresh(stored: CodexTokens): Promise<CodexTokens> {
    if (stored.refresh === "") {
      throw new Error("codex session expired and no refresh token is available — log in again");
    }
    let tr;
    try {
      tr = await refreshAccessToken(stored.refresh, this.fetchImpl);
    } catch (err) {
      // A rotated/revoked refresh token is unrecoverable — clear the dead
      // credentials so the next run prompts a clean login instead of looping.
      if (/invalid_grant/i.test(err instanceof Error ? err.message : "")) {
        clearCodexTokens(this.baseDir);
      }
      throw err;
    }
    const next = tokensToStored(tr, this.now(), stored.refresh);
    // Preserve the prior account id if the refreshed JWT omits it.
    const merged: CodexTokens =
      next.accountId === "" ? { ...next, accountId: stored.accountId } : next;
    writeCodexTokens(merged, this.baseDir);
    return merged;
  }
}
