/**
 * PKCE browser-loopback OAuth flow for codex (ChatGPT) auth.
 *
 * Opens the system browser to OpenAI's authorize endpoint, captures the code on
 * a localhost:1455 loopback, and exchanges it for tokens. Ported from opencode
 * `plugin/codex.ts`.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_PORT,
  CODEX_REDIRECT_URI,
  CODEX_SCOPE,
  exchangeCodeForTokens,
  type TokenResponse,
} from "./openai-codex-oauth-shared.js";

export interface PkceCodes {
  readonly verifier: string;
  readonly challenge: string;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): PkceCodes {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "openswarm",
  });
  return `${CODEX_AUTHORIZE_URL}?${params.toString()}`;
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.unref();
  } catch {
    // Non-fatal — the URL is also printed for manual paste.
  }
}

export interface BrowserOAuthOptions {
  readonly fetchImpl?: typeof fetch;
  /** Override browser launch (tests). Receives the authorize URL. */
  readonly openBrowser?: (url: string) => void;
  /** Where to print user instructions. Defaults to stdout. */
  readonly print?: (msg: string) => void;
  readonly timeoutMs?: number;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>OpenSwarm</title>" +
  "<body style='font-family:system-ui;text-align:center;padding-top:4rem'>" +
  "<h1>Authorized</h1><p>You can close this window and return to openswarm.</p>" +
  "<script>setTimeout(()=>window.close(),1500)</script>";

/**
 * Run the full browser PKCE flow and return the OAuth tokens. Resolves when the
 * loopback receives a valid callback; rejects on state mismatch, error, or
 * timeout. The loopback server is always torn down.
 */
export function runBrowserOAuth(opts: BrowserOAuthOptions = {}): Promise<TokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const openBrowser = opts.openBrowser ?? openInBrowser;
  const print = opts.print ?? ((m: string) => process.stdout.write(m));
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const pkce = generatePkce();
  const state = base64Url(randomBytes(32));
  const authorizeUrl = buildAuthorizeUrl(pkce.challenge, state);

  return new Promise<TokenResponse>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CODEX_REDIRECT_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      const fail = (status: number, msg: string): void => {
        res.writeHead(status, { "Content-Type": "text/plain" }).end(msg);
        cleanup();
        reject(new Error(msg));
      };
      if (error) return fail(400, `authorization failed: ${error}`);
      if (!code) return fail(400, "missing authorization code");
      if (returnedState !== state) return fail(400, "state mismatch (possible CSRF)");

      res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
      exchangeCodeForTokens({ code, redirectUri: CODEX_REDIRECT_URI, codeVerifier: pkce.verifier }, fetchImpl)
        .then((tokens) => {
          cleanup();
          resolve(tokens);
        })
        .catch((err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("codex login timed out waiting for browser authorization"));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
    // Bind loopback only — never expose the OAuth callback to the LAN. The
    // redirect_uri uses `localhost`, which resolves to 127.0.0.1 on the systems
    // the codex flow targets.
    server.listen(CODEX_REDIRECT_PORT, "127.0.0.1", () => {
      print(
        `\nOpening your browser to authorize OpenSwarm with ChatGPT...\n` +
          `If it doesn't open, paste this URL:\n\n${authorizeUrl}\n\n`,
      );
      openBrowser(authorizeUrl);
    });
  });
}
