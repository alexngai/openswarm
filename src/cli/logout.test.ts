import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock("../auth/openai-oauth.js", () => ({
  OpenAIOAuthAuth: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logoutMain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("missing --provider → exit 1 with error message", async () => {
    const errChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    });

    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain([]);

    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("logout requires --provider");
  });

  it("unknown provider → exit 1 with error message", async () => {
    const errChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    });

    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain(["--provider", "unknown-provider"]);

    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("unknown provider: unknown-provider");
  });

  it("codex-chatgpt with tokens present → calls auth.logout(), exit 0", async () => {
    const mockLogout = vi.fn().mockResolvedValue(undefined);
    const { OpenAIOAuthAuth } = await import("../auth/openai-oauth.js");
    (OpenAIOAuthAuth as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return { logout: mockLogout };
    });

    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain(["--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(mockLogout).toHaveBeenCalledOnce();
    expect(outChunks.join("")).toContain("logged out from codex-chatgpt");
  });

  it("codex-chatgpt with no tokens → auth.logout() called (handles internally), exit 0", async () => {
    // OpenAIOAuthAuth.logout() prints the "no credentials" message itself and returns.
    const mockLogout = vi.fn().mockResolvedValue(undefined);
    const { OpenAIOAuthAuth } = await import("../auth/openai-oauth.js");
    (OpenAIOAuthAuth as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return { logout: mockLogout };
    });

    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain(["--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(mockLogout).toHaveBeenCalledOnce();
  });

  it("claude-agent-sdk → prints informational message, exit 0", async () => {
    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain(["--provider", "claude-agent-sdk"]);

    expect(code).toBe(0);
    expect(outChunks.join("")).toContain("claude login");
  });
});
