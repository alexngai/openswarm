import { describe, it, expect, vi } from "vitest";
import { runDeviceOAuth } from "./openai-codex-device.js";

const ISSUER = "https://auth.openai.com";

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const noopSleep = async () => {};
const noopPrint = () => {};

describe("runDeviceOAuth", () => {
  it("throws if device authorization fails to start", async () => {
    const fetchImpl = vi.fn(async () => res(500, {})) as unknown as typeof fetch;
    await expect(runDeviceOAuth({ fetchImpl, print: noopPrint, sleep: noopSleep })).rejects.toThrow(/failed to start: 500/);
  });

  it("polls until approved, then exchanges with the device-callback redirect URI", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/deviceauth/usercode")) return res(200, { device_auth_id: "dev1", user_code: "WXYZ", interval: "1" });
      if (url.endsWith("/deviceauth/token")) {
        return calls.filter((u) => u.endsWith("/deviceauth/token")).length === 1
          ? res(403, {}) // pending
          : res(200, { authorization_code: "ac", code_verifier: "cv" });
      }
      // token exchange
      const form = new URLSearchParams(init.body as string);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("ac");
      expect(form.get("redirect_uri")).toBe(`${ISSUER}/deviceauth/callback`);
      return res(200, { access_token: "at", refresh_token: "rt" });
    }) as unknown as typeof fetch;

    const tr = await runDeviceOAuth({ fetchImpl, print: noopPrint, sleep: noopSleep });
    expect(tr.access_token).toBe("at");
  });

  it("treats a non-403/404 poll status as fatal", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/usercode")) return res(200, { device_auth_id: "d", user_code: "C", interval: "1" });
      return res(400, {});
    }) as unknown as typeof fetch;
    await expect(runDeviceOAuth({ fetchImpl, print: noopPrint, sleep: noopSleep })).rejects.toThrow(/failed: 400/);
  });

  it("stops early on an explicit denial while pending", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/usercode")) return res(200, { device_auth_id: "d", user_code: "C", interval: "1" });
      return res(403, { error: "access_denied" });
    }) as unknown as typeof fetch;
    await expect(runDeviceOAuth({ fetchImpl, print: noopPrint, sleep: noopSleep })).rejects.toThrow(/access_denied/);
  });

  it("honors the deadline instead of polling forever", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/usercode")) return res(200, { device_auth_id: "d", user_code: "C", interval: "1" });
      return res(404, {}); // perpetually pending
    }) as unknown as typeof fetch;
    await expect(
      runDeviceOAuth({ fetchImpl, print: noopPrint, sleep: noopSleep, timeoutMs: -1 }),
    ).rejects.toThrow(/timed out/);
  });
});
