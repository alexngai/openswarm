import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectAuth } from "./status.js";
import { AnthropicEnvAuth } from "./anthropic-env-auth.js";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by vitest before imports.
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn() };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "LITELLM_API_KEY",
] as const;

function clearAuthEnv() {
  for (const key of AUTH_ENV_KEYS) vi.stubEnv(key, "");
}

/** Stub the underlying execFile (callback form) to simulate keychain success. */
async function stubKeychainFound() {
  const { execFile } = await import("node:child_process");
  // execFile callback: (err, stdout, stderr)
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      cb(null, "", "");
    }
  );
}

/** Stub the underlying execFile (callback form) to simulate keychain miss. */
async function stubKeychainMissing() {
  const { execFile } = await import("node:child_process");
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      cb(new Error("security: SecKeychainSearchCopyNext OS Status -25300"));
    }
  );
}

/** Stub fs.access to resolve (file present). */
async function stubFileFound() {
  const fs = await import("node:fs/promises");
  (fs.access as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
}

/** Stub fs.access to reject (file absent). */
async function stubFileAbsent() {
  const fs = await import("node:fs/promises");
  (fs.access as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAuthEnv();
});

describe("detectAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", {
      value: process.platform,
      writable: true,
      configurable: true,
    });
  });

  // ---- Env var detection --------------------------------------------------

  it("returns env-api-key when ANTHROPIC_API_KEY is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");

    const result = await detectAuth();

    expect(result).toEqual({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });
  });

  it("returns env-oauth-token when only CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token-value");

    const result = await detectAuth();

    expect(result).toEqual({ state: "env-oauth-token", source: "CLAUDE_CODE_OAUTH_TOKEN" });
  });

  it("returns env-auth-token when only ANTHROPIC_AUTH_TOKEN is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "auth-bearer-token");

    const result = await detectAuth();

    expect(result).toEqual({ state: "env-auth-token", source: "ANTHROPIC_AUTH_TOKEN" });
  });

  it("ANTHROPIC_API_KEY takes priority over all other env vars", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-priority");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-also-set");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "auth-also-set");

    const result = await detectAuth();

    expect(result).toEqual({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });
  });

  it("does not match empty-string env vars (treats empty as unset)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");

    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    await stubFileAbsent();

    const result = await detectAuth();

    expect(result).toEqual({ state: "none" });
  });

  // ---- No credentials at all ----------------------------------------------

  it("returns none when no env vars set and no credential store found", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");

    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    await stubFileAbsent();

    const result = await detectAuth();

    expect(result).toEqual({ state: "none" });
  });

  // ---- Platform: macOS keychain -------------------------------------------

  it("returns keychain on darwin when security exits 0", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");

    Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
    await stubKeychainFound();

    const result = await detectAuth();

    expect(result).toEqual({ state: "keychain", service: "Claude Code-credentials" });
  });

  it("falls through to file check on darwin when keychain lookup fails", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");

    Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
    await stubKeychainMissing();
    await stubFileFound();

    const result = await detectAuth();

    expect(result).toEqual({
      state: "file",
      path: expect.stringContaining(".claude/.credentials.json"),
    });
  });

  // ---- Platform: Linux / Windows / other ----------------------------------

  it("returns file on linux when ~/.claude/.credentials.json exists", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");

    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    await stubFileFound();

    const result = await detectAuth();

    expect(result).toEqual({
      state: "file",
      path: expect.stringContaining(".claude/.credentials.json"),
    });
  });
});

// ---------------------------------------------------------------------------
// AnthropicEnvAuth tests
// ---------------------------------------------------------------------------

describe("AnthropicEnvAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", {
      value: process.platform,
      writable: true,
      configurable: true,
    });
  });

  it("kind is api-key and providerId is anthropic", () => {
    const auth = new AnthropicEnvAuth();

    expect(auth.kind).toBe("api-key");
    expect(auth.providerId).toBe("anthropic");
  });

  it("isAuthenticated() returns true when detectAuth finds a credential", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-present");

    const auth = new AnthropicEnvAuth();

    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("isAuthenticated() returns false when detectAuth finds nothing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");

    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    await stubFileAbsent();

    const auth = new AnthropicEnvAuth();

    expect(await auth.isAuthenticated()).toBe(false);
  });
});
