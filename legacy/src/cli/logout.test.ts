import { describe, it, expect, vi, afterEach } from "vitest";

const { logoutSpy } = vi.hoisted(() => ({ logoutSpy: vi.fn() }));
vi.mock("../auth/openai-codex-oauth.js", () => ({
  OpenAICodexAuth: class {
    logout = logoutSpy;
  },
}));

describe("logoutMain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logoutSpy.mockReset();
  });

  it("openai-codex → clears codex tokens, exit 0", async () => {
    logoutSpy.mockResolvedValue(undefined);
    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      outChunks.push(String(c));
      return true;
    });
    const { logoutMain } = await import("./logout.js");
    const code = await logoutMain(["--provider", "openai-codex"]);
    expect(code).toBe(0);
    expect(logoutSpy).toHaveBeenCalled();
    expect(outChunks.join("")).toContain("Cleared ChatGPT");
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
