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

  it("codex-chatgpt → prints redirect message and exits 0", async () => {
    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain(["--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(outChunks.join("")).toContain("codex logout");
  });

  it("codex-chatgpt → does not call OpenAIOAuthAuth.logout()", async () => {
    const mockLogout = vi.fn().mockResolvedValue(undefined);
    const { OpenAIOAuthAuth } = await import("../auth/openai-oauth.js");
    (OpenAIOAuthAuth as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return { logout: mockLogout };
    });

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain(["--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(mockLogout).not.toHaveBeenCalled();
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
