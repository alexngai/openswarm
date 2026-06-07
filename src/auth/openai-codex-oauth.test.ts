import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpenAICodexAuth } from "./openai-codex-oauth.js";
import { writeCodexTokens, readCodexTokens, type CodexTokens } from "./openai-codex-token-store.js";
import { runBrowserOAuth } from "./openai-codex-pkce.js";
import { runDeviceOAuth } from "./openai-codex-device.js";

vi.mock("./openai-codex-pkce.js", () => ({ runBrowserOAuth: vi.fn() }));
vi.mock("./openai-codex-device.js", () => ({ runDeviceOAuth: vi.fn() }));

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}
function codexToken(accountId: string, expSec: number): string {
  return jwt({ exp: expSec, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function jsonResponse(obj: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => obj, text: async () => JSON.stringify(obj) } as unknown as Response;
}

const NOW = 1_000_000_000_000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-oauth-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(overrides: Partial<CodexTokens> = {}): void {
  writeCodexTokens(
    { access: "old-access", refresh: "rt", accountId: "acc_1", expiresAt: NOW + 3_600_000, ...overrides },
    dir,
  );
}

describe("OpenAICodexAuth", () => {
  it("reports authentication state from the token store", async () => {
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    expect(await auth.isAuthenticated()).toBe(false);
    seed();
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("returns stored credentials without refreshing when the token is fresh", async () => {
    seed();
    const fetchImpl = vi.fn();
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await auth.getCredentials()).toEqual({ token: "old-access", accountId: "acc_1" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("silently refreshes when the access token is within the expiry buffer", async () => {
    seed({ expiresAt: NOW + 30_000 }); // < 60s buffer → refresh
    const newAccess = codexToken("acc_1", NOW / 1000 + 3600);
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: newAccess, refresh_token: "rt2" }));
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });

    const creds = await auth.getCredentials();
    expect(creds.token).toBe(newAccess);
    expect(creds.accountId).toBe("acc_1");
    expect(fetchImpl).toHaveBeenCalledOnce();
    // Store is rewritten with the rotated refresh token.
    expect(readCodexTokens(dir)?.refresh).toBe("rt2");
  });

  it("preserves the prior account id if a refreshed token omits it", async () => {
    seed({ expiresAt: NOW + 30_000 });
    const newAccess = jwt({ exp: NOW / 1000 + 3600 }); // no account-id claim
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: newAccess, refresh_token: "rt2" }));
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await auth.getCredentials()).accountId).toBe("acc_1");
  });

  it("headers() returns the bearer + account id", async () => {
    seed();
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    expect(await auth.headers()).toEqual({ Authorization: "Bearer old-access", "chatgpt-account-id": "acc_1" });
  });

  it("throws a helpful error when not authenticated", async () => {
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    await expect(auth.getCredentials()).rejects.toThrow(/login --provider openai-codex/);
  });

  it("logout clears the stored credentials", async () => {
    seed();
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    await auth.logout();
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("propagates a refresh 401 and leaves the stored tokens intact", async () => {
    seed({ expiresAt: NOW + 30_000 }); // within buffer → refresh
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_request" }, false));
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(auth.getCredentials()).rejects.toThrow(/codex token request failed/);
    expect(readCodexTokens(dir)?.access).toBe("old-access"); // not corrupted
  });

  it("clears dead credentials when the refresh token is invalid_grant", async () => {
    seed({ expiresAt: NOW + 30_000 });
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, false));
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(auth.getCredentials()).rejects.toThrow(/invalid_grant/);
    expect(readCodexTokens(dir)).toBeNull(); // dead tokens cleared
  });

  it("refresh() throws when not authenticated", async () => {
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    await expect(auth.refresh()).rejects.toThrow(/not authenticated/);
  });

  it("login() persists tokens from the browser flow", async () => {
    const access = codexToken("acc_new", NOW / 1000 + 3600);
    vi.mocked(runBrowserOAuth).mockResolvedValue({ access_token: access, refresh_token: "rt-new" });
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    await auth.login();
    expect(readCodexTokens(dir)).toMatchObject({ access, refresh: "rt-new", accountId: "acc_new" });
    expect(runDeviceOAuth).not.toHaveBeenCalled();
  });

  it("login({deviceCode:true}) uses the device flow", async () => {
    vi.mocked(runDeviceOAuth).mockResolvedValue({ access_token: codexToken("acc_d", NOW / 1000 + 3600), refresh_token: "rt" });
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    await auth.login({ deviceCode: true });
    expect(runDeviceOAuth).toHaveBeenCalled();
    expect(readCodexTokens(dir)?.accountId).toBe("acc_d");
  });

  it("login() fails fast (and persists nothing) when the token has no account id", async () => {
    vi.mocked(runBrowserOAuth).mockResolvedValue({ access_token: "opaque-non-jwt", refresh_token: "rt" });
    const auth = new OpenAICodexAuth({ baseDir: dir, now: () => NOW });
    await expect(auth.login()).rejects.toThrow(/no ChatGPT account id/);
    expect(readCodexTokens(dir)).toBeNull();
  });
});
