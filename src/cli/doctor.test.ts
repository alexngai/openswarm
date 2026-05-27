import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../auth/status.js", () => ({
  detectAuth: vi.fn(),
}));

// Mock execFile so codex-cli check can be exercised under controlled
// conditions. Default rejects with ENOENT so existing tests (which don't
// care about codex-cli) get a `warn` status that doesn't break overall
// checks. Using vi.hoisted because vi.mock factories hoist above const
// declarations.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), { stdout: "", stderr: "" });
    },
  ),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

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
    // config dir: not found; binary access: success
    (fs.access as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      if (String(p).includes(".swarm-harness")) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(undefined);
    });
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
    expect(parsed.checks).toHaveLength(5);
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

  it("config check is warn (not fail) when .swarm-harness/ is absent", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    // config dir: not found; binary access: success
    (fs.access as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      if (String(p).includes(".swarm-harness")) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(undefined);
    });
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
    // config dir: not found; binary access: success
    (fs.access as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      if (String(p).includes(".swarm-harness")) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(undefined);
    });
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

  // ---------------------------------------------------------------------------
  // install check — CLI binary branches
  // ---------------------------------------------------------------------------

  it("install check passes when CLI binary is accessible", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    // Distinguish config-dir access from binary access by argument.
    // Config dir contains ".swarm-harness"; binary path contains "claude".
    (fs.access as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      if (String(p).includes(".swarm-harness")) return Promise.reject(new Error("ENOENT"));
      // binary access — success
      return Promise.resolve(undefined);
    });
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { runDoctor } = await import("./doctor.js");
    const code = await runDoctor("json", process.cwd());

    const parsed = JSON.parse(chunks.join("").trim()) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const installCheck = parsed.checks.find((c) => c.name === "install");
    expect(installCheck?.status).toBe("pass");
    expect(installCheck?.message).toContain("CLI binary at");
    expect(code).toBe(0);
  });

  it("install check fails when CLI binary is missing", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    // All fs.access calls fail — config dir missing and binary missing.
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

    const parsed = JSON.parse(chunks.join("").trim()) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const installCheck = parsed.checks.find((c) => c.name === "install");
    expect(installCheck?.status).toBe("fail");
    expect(installCheck?.message).toContain("bundled CLI binary missing");
    expect(installCheck?.message).toContain("npm rebuild");
    expect(code).toBe(1);
  });

  it("install check warns when platform is not in the known bundled-binary list", async () => {
    const detectAuth = await getDetectAuth();
    detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });

    const fs = await getFsMock();
    (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Temporarily override platform to something unsupported.
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const origArch = Object.getOwnPropertyDescriptor(process, "arch");
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    try {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor("json", process.cwd());

      const parsed = JSON.parse(chunks.join("").trim()) as {
        checks: Array<{ name: string; status: string; message: string }>;
      };
      const installCheck = parsed.checks.find((c) => c.name === "install");
      expect(installCheck?.status).toBe("warn");
      expect(installCheck?.message).toContain("not in the known bundled-binary list");
    } finally {
      // Restore platform/arch.
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
      if (origArch) Object.defineProperty(process, "arch", origArch);
    }
  });

  // ---------------------------------------------------------------------------
  // codex-cli check (Stage 3C)
  // ---------------------------------------------------------------------------

  it("codex-cli check: warn when codex binary is absent", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: object,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), { stdout: "", stderr: "" });
      },
    );
    try {
      const detectAuth = await getDetectAuth();
      detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });
      const fs = await getFsMock();
      (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
      (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const captured: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      });

      const { runDoctor } = await import("./doctor.js");
      await runDoctor("json");
      const parsed = JSON.parse(captured.join(""));
      const codexCheck = parsed.checks.find(
        (c: { name: string }) => c.name === "codex-cli",
      );
      expect(codexCheck).toBeDefined();
      expect(codexCheck.status).toBe("warn");
      expect(codexCheck.message).toContain("npm install -g @openai/codex");
    } finally {
      execFileMock.mockReset();
    }
  });

  it("codex-cli check: pass with version when codex binary is present", async () => {
    execFileMock.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: object,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === "codex") {
          cb(null, { stdout: "codex-cli 0.98.0\n", stderr: "" });
        } else {
          // which/where codex
          cb(null, { stdout: "/usr/local/bin/codex\n", stderr: "" });
        }
      },
    );
    try {
      const detectAuth = await getDetectAuth();
      detectAuth.mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" });
      const fs = await getFsMock();
      (fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));
      (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const captured: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      });

      const { runDoctor } = await import("./doctor.js");
      await runDoctor("json");
      const parsed = JSON.parse(captured.join(""));
      const codexCheck = parsed.checks.find(
        (c: { name: string }) => c.name === "codex-cli",
      );
      expect(codexCheck).toBeDefined();
      expect(codexCheck.status).toBe("pass");
      expect(codexCheck.message).toContain("codex-cli 0.98.0");
      expect(codexCheck.message).toContain("/usr/local/bin/codex");
    } finally {
      execFileMock.mockReset();
    }
  });
});
