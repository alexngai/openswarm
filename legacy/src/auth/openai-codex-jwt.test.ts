import { describe, it, expect } from "vitest";
import { resolveCodexIdentity, resolveCodexExpiry } from "./openai-codex-jwt.js";

/** Build a fake JWT (header.payload.signature) with the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

describe("resolveCodexIdentity", () => {
  it("extracts account id, plan, email, and expiry from claims", () => {
    const token = jwt({
      exp: 1_900_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acc_123", chatgpt_plan_type: "pro" },
      "https://api.openai.com/profile": { email: "a@b.com" },
    });
    expect(resolveCodexIdentity(token)).toEqual({
      accountId: "acc_123",
      planType: "pro",
      email: "a@b.com",
      expiresAt: 1_900_000_000_000,
    });
  });

  it("returns an empty identity for a non-JWT string", () => {
    expect(resolveCodexIdentity("not-a-jwt")).toEqual({});
  });

  it("omits fields that are absent", () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_x" } });
    expect(resolveCodexIdentity(token)).toEqual({ accountId: "acc_x" });
  });

  it("resolveCodexExpiry returns epoch-ms expiry", () => {
    expect(resolveCodexExpiry(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
    expect(resolveCodexExpiry("bad")).toBeUndefined();
  });
});
