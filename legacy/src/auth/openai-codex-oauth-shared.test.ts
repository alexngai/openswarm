import { describe, it, expect, vi } from "vitest";
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  tokensToStored,
  CODEX_TOKEN_URL,
  CODEX_CLIENT_ID,
} from "./openai-codex-oauth-shared.js";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}
function ok(obj: unknown): Response {
  return { ok: true, status: 200, json: async () => obj, text: async () => "" } as unknown as Response;
}

describe("token exchange / refresh", () => {
  it("exchangeCodeForTokens posts the authorization_code grant", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(init.body as string);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("the-code");
      expect(form.get("code_verifier")).toBe("v");
      expect(form.get("client_id")).toBe(CODEX_CLIENT_ID);
      return ok({ access_token: "at", refresh_token: "rt" });
    }) as unknown as typeof fetch;
    const tr = await exchangeCodeForTokens(
      { code: "the-code", redirectUri: "http://localhost:1455/auth/callback", codeVerifier: "v" },
      fetchImpl,
    );
    expect(tr.access_token).toBe("at");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(CODEX_TOKEN_URL);
  });

  it("refreshAccessToken posts the refresh_token grant", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(init.body as string);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("rt");
      return ok({ access_token: "at2", refresh_token: "rt2" });
    }) as unknown as typeof fetch;
    expect((await refreshAccessToken("rt", fetchImpl)).access_token).toBe("at2");
  });

  it("throws on a non-2xx token response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, text: async () => "bad" }) as unknown as Response) as unknown as typeof fetch;
    await expect(refreshAccessToken("rt", fetchImpl)).rejects.toThrow(/401/);
  });
});

describe("tokensToStored", () => {
  it("derives account id + expiry from the access-token JWT", () => {
    const access = jwt({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acc" } });
    const stored = tokensToStored({ access_token: access, refresh_token: "rt" }, 1_000);
    expect(stored).toEqual({ access, refresh: "rt", accountId: "acc", expiresAt: 2_000_000_000_000 });
  });

  it("falls back to expires_in when the JWT lacks exp, and to the prior refresh token", () => {
    const stored = tokensToStored({ access_token: "opaque", refresh_token: "" }, 1_000, "prior-rt");
    expect(stored.refresh).toBe("prior-rt");
    expect(stored.expiresAt).toBe(1_000 + 3600 * 1000);
    expect(stored.accountId).toBe("");
  });
});
