/**
 * OpenAIOAuthAuth — OAuth 2.0 + PKCE login for ChatGPT Plus/Pro via the
 * Codex App Server endpoint.
 *
 * REVERSE-ENGINEERED CONSTANTS — policy-tolerated, not contracted:
 *   CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
 *   AUTH_URL  = "https://auth.openai.com/oauth/authorize"
 *   TOKEN_URL = "https://auth.openai.com/oauth/token"
 *
 * If this CLIENT_ID is revoked, the login flow will return 4xx.
 * The feature becomes unavailable until OpenAI restores it.
 * No auto-fallback; surface OAuthRefreshFailedError.
 *
 * See docs/06-open-questions.md Q17 for contingency discussion.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { InteractiveAuth } from "./index.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class OAuthRefreshFailedError extends Error {
  readonly code = "oauth_refresh_failed" as const;
  constructor(message: string) {
    super(message);
    this.name = "OAuthRefreshFailedError";
  }
}

// ---------------------------------------------------------------------------
// Token shape persisted to auth.json
// ---------------------------------------------------------------------------

interface TokenRecord {
  access_token: string;
  refresh_token?: string;
  /** Unix seconds */
  expires_at: number;
  scopes: string[];
}

/** Shape of the full auth.json file (multi-provider) */
type AuthFile = Record<string, TokenRecord>;

// ---------------------------------------------------------------------------
// Injection options (for testing)
// ---------------------------------------------------------------------------

export interface OpenAIOAuthAuthOptions {
  /** Override path to ~/.swarm-coder/auth.json */
  authFilePath?: string;
  /** Override fetch for token endpoint calls */
  fetch?: typeof globalThis.fetch;
  /** Override browser opener */
  openBrowser?: (url: string) => Promise<void>;
  /** Override current time (returns unix seconds) */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class OpenAIOAuthAuth implements InteractiveAuth {
  readonly kind = "oauth-bearer" as const;
  readonly providerId = "openai";

  private readonly authFilePath: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly openBrowserFn: (url: string) => Promise<void>;
  private readonly nowFn: () => number;

  constructor(opts: OpenAIOAuthAuthOptions = {}) {
    this.authFilePath =
      opts.authFilePath ??
      path.join(os.homedir(), ".swarm-coder", "auth.json");
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.openBrowserFn = opts.openBrowser ?? defaultOpenBrowser;
    this.nowFn = opts.now ?? (() => Date.now() / 1000);
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  async login(opts?: {
    deviceCode?: boolean;
    timeoutMs?: number;
    openBrowser?: (url: string) => Promise<void>;
  }): Promise<void> {
    const timeoutMs =
      opts?.timeoutMs ??
      Number(process.env["SWARM_CODER_OAUTH_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS);

    const openBrowser = opts?.openBrowser ?? this.openBrowserFn;

    // 1. PKCE
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest()
      .toString("base64url");

    const state = crypto.randomBytes(16).toString("base64url");

    // 2. Loopback listener on ephemeral port
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!DOCTYPE html><html><body><p>Authentication successful — you can close this tab.</p></body></html>",
        );
        if (code) {
          resolveCode(code);
        } else {
          rejectCode(new Error("OAuth callback missing 'code' parameter"));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((res, rej) => {
      server.listen(0, "127.0.0.1", () => res());
      server.on("error", rej);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to bind loopback server");
    }
    const port = address.port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    // 3. Build auth URL
    const authUrl =
      `${AUTH_URL}` +
      `?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent("openid profile email")}` +
      `&state=${state}`;

    // 4. Open browser
    await openBrowser(authUrl);

    // 5. Wait for callback with timeout
    let code: string;
    try {
      code = await withTimeout(codePromise, timeoutMs, "OAuth login timed out");
    } finally {
      server.close();
    }

    // 6. Exchange code for tokens
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
    });

    const tokenRes = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      throw new OAuthRefreshFailedError(
        `Re-authenticate via \`swarm-coder login --provider codex-chatgpt\`.`,
      );
    }

    const json = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const record: TokenRecord = {
      access_token: json.access_token,
      ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
      expires_at: this.nowFn() + json.expires_in,
      scopes: json.scope ? json.scope.split(" ") : [],
    };

    // 7. Persist tokens (multi-provider safe)
    await this._writeTokens(record);
  }

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------

  async logout(): Promise<void> {
    let file: AuthFile = {};
    try {
      const raw = await fs.readFile(this.authFilePath, "utf8");
      file = JSON.parse(raw) as AuthFile;
    } catch {
      console.log("no credentials stored for openai-oauth");
      return;
    }

    if (!("openai-oauth" in file)) {
      console.log("no credentials stored for openai-oauth");
      return;
    }

    delete file["openai-oauth"];
    await atomicWriteJson(this.authFilePath, file);
  }

  // -------------------------------------------------------------------------
  // headers
  // -------------------------------------------------------------------------

  async headers(): Promise<Record<string, string>> {
    const tokens = await this._readTokens();
    if (!tokens) {
      throw new Error(
        "not authenticated; run `swarm-coder login --provider codex-chatgpt`",
      );
    }

    if (tokens.expires_at <= this.nowFn()) {
      await this.refresh();
      // Re-read after refresh
      const refreshed = await this._readTokens();
      if (!refreshed) {
        throw new Error(
          "not authenticated; run `swarm-coder login --provider codex-chatgpt`",
        );
      }
      return { Authorization: `Bearer ${refreshed.access_token}` };
    }

    return { Authorization: `Bearer ${tokens.access_token}` };
  }

  // -------------------------------------------------------------------------
  // refresh
  // -------------------------------------------------------------------------

  async refresh(): Promise<void> {
    const tokens = await this._readTokens();
    if (!tokens?.refresh_token) {
      throw new OAuthRefreshFailedError(
        `Re-authenticate via \`swarm-coder login --provider codex-chatgpt\`.`,
      );
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    });

    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new OAuthRefreshFailedError(
        `Re-authenticate via \`swarm-coder login --provider codex-chatgpt\`.`,
      );
    }

    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const updated: TokenRecord = {
      access_token: json.access_token,
      // Preserve old refresh_token if response omits it (claw pattern)
      refresh_token: json.refresh_token ?? tokens.refresh_token,
      expires_at: this.nowFn() + json.expires_in,
      scopes: json.scope ? json.scope.split(" ") : tokens.scopes,
    };

    await this._writeTokens(updated);
  }

  // -------------------------------------------------------------------------
  // isAuthenticated
  // -------------------------------------------------------------------------

  async isAuthenticated(): Promise<boolean> {
    const tokens = await this._readTokens();
    if (!tokens) return false;

    if (tokens.expires_at > this.nowFn()) return true;

    // Expired — try refresh
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _readTokens(): Promise<TokenRecord | null> {
    try {
      const raw = await fs.readFile(this.authFilePath, "utf8");
      const file = JSON.parse(raw) as AuthFile;
      return (file["openai-oauth"] as TokenRecord) ?? null;
    } catch {
      return null;
    }
  }

  private async _writeTokens(record: TokenRecord): Promise<void> {
    // Read-merge-write so we don't stomp other provider keys
    let file: AuthFile = {};
    try {
      const raw = await fs.readFile(this.authFilePath, "utf8");
      file = JSON.parse(raw) as AuthFile;
    } catch {
      // File doesn't exist yet — start fresh
    }

    file["openai-oauth"] = record;
    await atomicWriteJson(this.authFilePath, file);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}
