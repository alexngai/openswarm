/**
 * Headless device-code OAuth flow for codex (ChatGPT) auth.
 *
 * For environments without a browser/loopback (SSH, containers). Polls OpenAI's
 * device-auth endpoints until the user approves, then exchanges for tokens.
 * Ported from opencode `plugin/codex.ts`.
 */

import {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  exchangeCodeForTokens,
  type TokenResponse,
} from "./openai-codex-oauth-shared.js";

interface DeviceAuthStart {
  device_auth_id: string;
  user_code: string;
  interval?: string;
}

export interface DeviceOAuthOptions {
  readonly fetchImpl?: typeof fetch;
  readonly print?: (msg: string) => void;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Safety cap on total polling time. */
  readonly timeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const POLL_SAFETY_MS = 3000;

export async function runDeviceOAuth(opts: DeviceOAuthOptions = {}): Promise<TokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const print = opts.print ?? ((m: string) => process.stdout.write(m));
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);

  const startRes = await fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!startRes.ok) {
    throw new Error(`device authorization failed to start: ${startRes.status}`);
  }
  const device = (await startRes.json()) as DeviceAuthStart;
  const intervalMs = Math.max(parseInt(device.interval ?? "5", 10) || 5, 1) * 1000;

  print(
    `\nTo authorize swarm-harness with ChatGPT:\n` +
      `  1. Visit: ${CODEX_ISSUER}/codex/device\n` +
      `  2. Enter code: ${device.user_code}\n\nWaiting for approval...\n`,
  );

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("codex device login timed out waiting for approval");
    }
    const res = await fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    });

    if (res.ok) {
      const data = (await res.json()) as { authorization_code: string; code_verifier: string };
      return exchangeCodeForTokens(
        {
          code: data.authorization_code,
          redirectUri: `${CODEX_ISSUER}/deviceauth/callback`,
          codeVerifier: data.code_verifier,
        },
        fetchImpl,
      );
    }
    // 403/404 mean "not approved yet" — keep polling; anything else is fatal.
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`device authorization failed: ${res.status}`);
    }
    await sleep(intervalMs + POLL_SAFETY_MS);
  }
}
