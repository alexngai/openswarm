import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../auth/status.js", () => ({
  detectAuth: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDetectAuth() {
  const mod = await import("../auth/status.js");
  return mod.detectAuth as ReturnType<typeof vi.fn>;
}

async function getFsMock() {
  return import("node:fs/promises");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("text format: prints ✓ for passing checks and returns 0 when auth is present", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    // config dir: not found
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    // workspace probe: success
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    const code = await runDoctor("text", process.cwd());

    process.stdout.write = origWrite;

    const output = chunks.join("");
    expect(output).toContain("✓ auth:");
    expect(output).toContain("ANTHROPIC_API_KEY set");
    expect(code).toBe(0);
  });

  it("text format: prints ✗ for auth failure and returns 1", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "none" });

    const fs = await getFsMock();
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    const code = await runDoctor("text", process.cwd());

    const output = chunks.join("");
    expect(output).toContain("✗ auth:");
    expect(output).toContain("claude auth login");
    expect(code).toBe(1);
  });

  it("json format: emits valid JSON with checks array and overall field", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    await runDoctor("json", process.cwd());

    const output = chunks.join("").trim();
    const parsed = JSON.parse(output) as { checks: unknown[]; overall: string };
    expect(parsed).toHaveProperty("checks");
    expect(parsed).toHaveProperty("overall");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks).toHaveLength(4);
    expect(["pass", "fail"]).toContain(parsed.overall);
  });

  it("json format: overall is fail when auth check fails", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "none" });

    const fs = await getFsMock();
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    const code = await runDoctor("json", process.cwd());

    const output = chunks.join("").trim();
    const parsed = JSON.parse(output) as { overall: string };
    expect(parsed.overall).toBe("fail");
    expect(code).toBe(1);
  });

  it("config check is warn (not fail) when .swarm-coder/ is absent", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    const code = await runDoctor("json", process.cwd());

    const output = chunks.join("").trim();
    const parsed = JSON.parse(output) as {
      checks: Array<{ name: string; status: string }>;
      overall: string;
    };
    const configCheck = parsed.checks.find((c) => c.name === "config");
    expect(configCheck?.status).toBe("warn");
    // warn does not cause failure
    expect(code).toBe(0);
  });

  it("workspace check fails when cwd is not writable", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    // config found
    (fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // workspace probe fails
    (fs.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("EACCES: permission denied"));

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    const code = await runDoctor("json", process.cwd());

    const output = chunks.join("").trim();
    const parsed = JSON.parse(output) as {
      checks: Array<{ name: string; status: string }>;
      overall: string;
    };
    const wsCheck = parsed.checks.find((c) => c.name === "workspace");
    expect(wsCheck?.status).toBe("fail");
    expect(code).toBe(1);
  });

  it("keychain auth source is reported in pass message", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "keychain", service: "Claude Code-credentials" });

    const fs = await getFsMock();
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    const code = await runDoctor("text", process.cwd());

    const output = chunks.join("");
    expect(output).toContain("keychain credential found");
    expect(code).toBe(0);
  });
});
