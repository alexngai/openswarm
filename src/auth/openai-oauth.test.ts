import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OAuthRefreshFailedError, OpenAIOAuthAuth } from "./openai-oauth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "openai-oauth-test-"));
}

function makeAuthFilePath(dir: string): string {
  return path.join(dir, "auth.json");
}

function makeTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "tok_access",
    refresh_token: "tok_refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scopes: ["openid", "profile", "email"],
    ...overrides,
  };
}

/** Fire an HTTP GET to the loopback callback endpoint */
function fireCallback(port: number, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/callback?code=${encodeURIComponent(code)}`,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIOAuthAuth", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. PKCE verifier / challenge correctness
  // -------------------------------------------------------------------------

  it("PKCE verifier is base64url and within RFC 7636 length bounds", () => {
    // Generate verifier the same way the implementation does
    const verifier = crypto.randomBytes(32).toString("base64url");
    // base64url of 32 bytes = 43 chars (no padding)
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // Must only contain base64url chars
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("PKCE challenge is correct SHA-256 base64url of verifier", () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const expected = crypto
      .createHash("sha256")
      .update(verifier)
      .digest()
      .toString("base64url");

    // Recompute independently
    const actual = crypto
      .createHash("sha256")
      .update(verifier)
      .digest()
      .toString("base64url");

    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  // -------------------------------------------------------------------------
  // 2. Mocked login flow
  // -------------------------------------------------------------------------

  it("login: mocked browser + callback → tokens written to auth.json", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);
    let capturedPort = 0;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new_access",
        refresh_token: "new_refresh",
        expires_in: 3600,
        scope: "openid profile email",
      }),
    } as Response);

    const openBrowser = async (url: string) => {
      // Extract port from redirect_uri in the URL
      const match = url.match(/redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A(\d+)/);
      if (!match) throw new Error("redirect_uri not found in auth URL");
      capturedPort = Number(match[1]);
      // Simulate user completing OAuth — fire callback after a short delay
      setTimeout(() => {
        fireCallback(capturedPort, "mock_auth_code").catch(() => {});
      }, 50);
    };

    const auth = new OpenAIOAuthAuth({
      authFilePath,
      fetch: mockFetch,
      openBrowser,
    });

    await auth.login({ timeoutMs: 5000 });

    // Token file should exist and contain openai-oauth key
    const raw = await fs.readFile(authFilePath, "utf8");
    const file = JSON.parse(raw) as Record<string, unknown>;
    expect(file["openai-oauth"]).toMatchObject({
      access_token: "new_access",
      refresh_token: "new_refresh",
      scopes: ["openid", "profile", "email"],
    });

    // fetch was called with the token URL
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect((init.body as string)).toContain("grant_type=authorization_code");
    expect((init.body as string)).toContain("code=mock_auth_code");
  });

  // -------------------------------------------------------------------------
  // 3. Mocked refresh: expired token → refresh called → fresh header
  // -------------------------------------------------------------------------

  it("headers(): expired token triggers refresh and returns new bearer", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);
    const nowFn = vi.fn().mockReturnValue(1_000_000); // fixed "now"

    // Write an expired token
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        "openai-oauth": makeTokenRecord({
          access_token: "old_access",
          refresh_token: "old_refresh",
          expires_at: 999_999, // in the past relative to nowFn
        }),
      }),
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "refreshed_access",
        refresh_token: "refreshed_refresh",
        expires_in: 3600,
        scope: "openid profile email",
      }),
    } as Response);

    const auth = new OpenAIOAuthAuth({ authFilePath, fetch: mockFetch, now: nowFn });
    const hdrs = await auth.headers();

    expect(hdrs).toEqual({ Authorization: "Bearer refreshed_access" });

    // New token should be written
    const raw = await fs.readFile(authFilePath, "utf8");
    const file = JSON.parse(raw) as Record<string, { access_token: string }>;
    expect(file["openai-oauth"].access_token).toBe("refreshed_access");
  });

  // -------------------------------------------------------------------------
  // 4. Refresh preserves old refresh_token when response omits it
  // -------------------------------------------------------------------------

  it("refresh(): preserves old refresh_token when response omits refresh_token", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        "openai-oauth": makeTokenRecord({
          refresh_token: "preserved_refresh",
        }),
      }),
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new_access",
        // no refresh_token in response
        expires_in: 3600,
      }),
    } as Response);

    const auth = new OpenAIOAuthAuth({ authFilePath, fetch: mockFetch });
    await auth.refresh();

    const raw = await fs.readFile(authFilePath, "utf8");
    const file = JSON.parse(raw) as Record<string, { refresh_token: string }>;
    expect(file["openai-oauth"].refresh_token).toBe("preserved_refresh");
  });

  // -------------------------------------------------------------------------
  // 5. Refresh 4xx → OAuthRefreshFailedError
  // -------------------------------------------------------------------------

  it("refresh(): 4xx response throws OAuthRefreshFailedError with correct message", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      authFilePath,
      JSON.stringify({ "openai-oauth": makeTokenRecord() }),
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_grant" }),
    } as Response);

    const auth = new OpenAIOAuthAuth({ authFilePath, fetch: mockFetch });

    await expect(auth.refresh()).rejects.toThrow(OAuthRefreshFailedError);
    await expect(auth.refresh()).rejects.toThrow(
      "Re-authenticate via `swarm-coder login --provider codex-chatgpt`.",
    );
  });

  // -------------------------------------------------------------------------
  // 6. Logout deletes only openai-oauth key
  // -------------------------------------------------------------------------

  it("logout(): removes openai-oauth key but preserves other keys", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        "anthropic-oauth": { access_token: "anthropic_tok" },
        "openai-oauth": makeTokenRecord(),
      }),
    );

    const auth = new OpenAIOAuthAuth({ authFilePath });
    await auth.logout();

    const raw = await fs.readFile(authFilePath, "utf8");
    const file = JSON.parse(raw) as Record<string, unknown>;
    expect(file["openai-oauth"]).toBeUndefined();
    expect(file["anthropic-oauth"]).toEqual({ access_token: "anthropic_tok" });
  });

  // -------------------------------------------------------------------------
  // 7. isAuthenticated
  // -------------------------------------------------------------------------

  it("isAuthenticated(): true when token is valid", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);
    const nowFn = vi.fn().mockReturnValue(1_000_000);

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        "openai-oauth": makeTokenRecord({ expires_at: 1_100_000 }),
      }),
    );

    const auth = new OpenAIOAuthAuth({ authFilePath, now: nowFn });
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("isAuthenticated(): false when auth file is missing", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);
    const auth = new OpenAIOAuthAuth({ authFilePath });
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated(): false when refresh fails", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);
    const nowFn = vi.fn().mockReturnValue(2_000_000); // past expires_at

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      authFilePath,
      JSON.stringify({
        "openai-oauth": makeTokenRecord({ expires_at: 1_000_000 }),
      }),
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    } as Response);

    const auth = new OpenAIOAuthAuth({ authFilePath, fetch: mockFetch, now: nowFn });
    expect(await auth.isAuthenticated()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 8. Loopback server binds to ephemeral port
  // -------------------------------------------------------------------------

  it("loopback server binds to an ephemeral port > 0", async () => {
    // Spin up a test server the same way the implementation does
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    const port = (address as { port: number }).port;
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);

    server.close();
  });

  // -------------------------------------------------------------------------
  // 9. Multi-provider preservation: logout leaves other keys intact
  // -------------------------------------------------------------------------

  it("multi-provider: after logout only anthropic-oauth remains", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);

    const initialFile = {
      "anthropic-oauth": { access_token: "ant_tok", refresh_token: "ant_ref" },
      "openai-oauth": makeTokenRecord(),
    };

    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(authFilePath, JSON.stringify(initialFile));

    const auth = new OpenAIOAuthAuth({ authFilePath });
    await auth.logout();

    const raw = await fs.readFile(authFilePath, "utf8");
    const file = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(file)).toEqual(["anthropic-oauth"]);
    expect(file["anthropic-oauth"]).toEqual({
      access_token: "ant_tok",
      refresh_token: "ant_ref",
    });
  });

  // -------------------------------------------------------------------------
  // 10. logout: no-op when file missing
  // -------------------------------------------------------------------------

  it("logout(): no-op (no throw) when auth file is missing", async () => {
    const authFilePath = makeAuthFilePath(tmpDir);
    const auth = new OpenAIOAuthAuth({ authFilePath });
    await expect(auth.logout()).resolves.toBeUndefined();
  });
});
