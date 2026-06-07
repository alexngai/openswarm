import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { generatePkce, buildAuthorizeUrl, runBrowserOAuth } from "./openai-codex-pkce.js";
import { CODEX_CLIENT_ID, CODEX_REDIRECT_URI } from "./openai-codex-oauth-shared.js";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("generatePkce", () => {
  it("derives the challenge as base64url(SHA-256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(b64url(createHash("sha256").update(verifier).digest()));
  });

  it("produces a unique verifier each call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes the required PKCE + client params", () => {
    const url = new URL(buildAuthorizeUrl("chal", "state-xyz"));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(CODEX_REDIRECT_URI);
    expect(p.get("code_challenge")).toBe("chal");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("state-xyz");
    expect(p.get("originator")).toBe("swarm-harness");
  });
});

describe("runBrowserOAuth (loopback)", () => {
  // Drive the real loopback server: openBrowser captures the authorize URL and
  // fires the callback; fetchImpl stubs only the token exchange.
  const tokenExchange = vi.fn(async () =>
    ({ ok: true, status: 200, json: async () => ({ access_token: "at", refresh_token: "rt" }), text: async () => "" }) as unknown as Response,
  ) as unknown as typeof fetch;

  function hitCallback(query: (state: string) => string) {
    return (url: string) => {
      const state = new URL(url).searchParams.get("state") ?? "";
      void fetch(`http://127.0.0.1:1455/auth/callback?${query(state)}`).catch(() => {});
    };
  }

  it("resolves with exchanged tokens on a valid callback", async () => {
    const tr = await runBrowserOAuth({
      fetchImpl: tokenExchange,
      openBrowser: hitCallback((state) => `code=abc&state=${state}`),
      print: () => {},
      timeoutMs: 5000,
    });
    expect(tr.access_token).toBe("at");
  });

  it("rejects on a state mismatch (CSRF guard)", async () => {
    await expect(
      runBrowserOAuth({
        openBrowser: hitCallback(() => `code=abc&state=WRONG`),
        print: () => {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it("rejects when the provider returns an error param", async () => {
    await expect(
      runBrowserOAuth({
        openBrowser: hitCallback((state) => `error=access_denied&state=${state}`),
        print: () => {},
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("times out if no callback arrives, tearing down the server", async () => {
    await expect(
      runBrowserOAuth({ openBrowser: () => {}, print: () => {}, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });
});
