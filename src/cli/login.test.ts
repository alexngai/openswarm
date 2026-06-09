import { describe, it, expect, vi, afterEach } from "vitest";

const { loginSpy } = vi.hoisted(() => ({ loginSpy: vi.fn() }));
vi.mock("../auth/openai-codex-oauth.js", () => ({
  OpenAICodexAuth: class {
    login = loginSpy;
  },
}));

describe("loginMain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    loginSpy.mockReset();
  });

  it("openai-codex → browser login, exit 0", async () => {
    loginSpy.mockResolvedValue(undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { loginMain } = await import("./login.js");
    const code = await loginMain(["--provider", "openai-codex"]);
    expect(code).toBe(0);
    expect(loginSpy).toHaveBeenCalledWith({ deviceCode: false });
  });

  it("openai-codex --device → device login", async () => {
    loginSpy.mockResolvedValue(undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { loginMain } = await import("./login.js");
    await loginMain(["--provider", "openai-codex", "--device"]);
    expect(loginSpy).toHaveBeenCalledWith({ deviceCode: true });
  });

  it("openai-codex login failure → exit 2", async () => {
    loginSpy.mockRejectedValue(new Error("boom"));
    const errChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      errChunks.push(String(c));
      return true;
    });
    const { loginMain } = await import("./login.js");
    const code = await loginMain(["--provider", "openai-codex"]);
    expect(code).toBe(2);
    expect(errChunks.join("")).toContain("ChatGPT login failed");
  });

  it("codex-chatgpt → prints redirect message and exits 0", async () => {
    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { loginMain } = await import("./login.js");
    const code = await loginMain(["--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(outChunks.join("")).toContain("codex login");
  });

  it("claude-agent-sdk → prints informational message, exit 0", async () => {
    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { loginMain } = await import("./login.js");
    const code = await loginMain(["--provider", "claude-agent-sdk"]);

    expect(code).toBe(0);
    expect(outChunks.join("")).toContain("claude login");
  });

  it("no --provider → defaults to claude-agent-sdk path, exit 0", async () => {
    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { loginMain } = await import("./login.js");
    const code = await loginMain([]);

    expect(code).toBe(0);
    expect(outChunks.join("")).toContain("claude login");
  });

  it("unknown provider → exit 1 with error message", async () => {
    const errChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    });

    const { loginMain } = await import("./login.js");
    const code = await loginMain(["--provider", "some-unknown"]);

    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("unknown provider");
  });

  it("codex-chatgpt → redirect message mentions @openai/codex install hint", async () => {
    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { loginMain } = await import("./login.js");
    const code = await loginMain(["--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(outChunks.join("")).toContain("@openai/codex");
  });
});
