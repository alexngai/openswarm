import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generatePkce, buildAuthorizeUrl } from "./openai-codex-pkce.js";
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
