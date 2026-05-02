import { describe, it, expect, vi, afterEach } from "vitest";

describe("loginMain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
