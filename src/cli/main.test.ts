import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports of the modules under test.
// ---------------------------------------------------------------------------

vi.mock("./doctor.js", () => ({
  runDoctor: vi.fn().mockResolvedValue(0),
}));

vi.mock("./init.js", () => ({
  runInit: vi.fn().mockResolvedValue(0),
}));

vi.mock("./plugin.js", () => ({
  pluginMain: vi.fn().mockResolvedValue(0),
}));

vi.mock("./login.js", () => ({
  loginMain: vi.fn().mockResolvedValue(0),
}));

vi.mock("./logout.js", () => ({
  logoutMain: vi.fn().mockResolvedValue(0),
}));

vi.mock("../tools/framework-filter.js", () => ({
  filterToolsForFramework: vi.fn((tools: unknown[]) => tools),
}));

vi.mock("../auth/status.js", () => ({
  detectAuth: vi.fn().mockResolvedValue({ state: "env-api-key", source: "ANTHROPIC_API_KEY" }),
}));

vi.mock("../auth/anthropic-env-auth.js", () => ({
  AnthropicEnvAuth: function AnthropicEnvAuth() {
    return {
      kind: "api-key",
      providerId: "anthropic",
      headers: async () => ({}),
      isAuthenticated: async () => true,
    };
  },
}));

vi.mock("../tools/dispatcher.js", () => ({
  ToolDispatcher: function ToolDispatcher() {
    return {
      register: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
      list: vi.fn().mockReturnValue([]),
    };
  },
}));

vi.mock("../tools/tier0/index.js", () => ({
  buildTier0Tools: vi.fn().mockReturnValue([]),
}));

vi.mock("../permissions/index.js", () => ({
  PermissionEngine: function PermissionEngine() {
    return {
      check: vi.fn().mockReturnValue({ allow: true }),
    };
  },
}));

vi.mock("../engine/claude-agent-sdk.js", () => ({
  ClaudeAgentSdkEngine: function ClaudeAgentSdkEngine() {
    return {
      id: "claude-agent-sdk",
      capabilities: {},
      run: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      ),
    };
  },
}));

vi.mock("../engine/native.js", () => ({
  NativeEngine: function NativeEngine() {
    return {
      id: "native",
      capabilities: {},
      run: vi.fn().mockReturnValue(
        (async function* () {
          yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      ),
    };
  },
}));

vi.mock("../providers/routing.js", () => ({
  resolveProvider: vi.fn((modelId: string) => {
    if (/^claude/i.test(modelId)) {
      return {
        kind: "sdk",
        engineFactory: () => ({
          id: "claude-agent-sdk",
          capabilities: {},
          run: async function* () {
            yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          },
        }),
        modelId,
      };
    }
    return {
      kind: "native",
      providerFactory: async () => ({ id: "openai", model: {}, capabilities: {}, stream: async function* () {} }),
      modelId,
    };
  }),
}));

vi.mock("../providers/aliases.js", () => ({
  loadAliases: vi.fn().mockResolvedValue({}),
  resolveAlias: vi.fn((modelId: string) => modelId),
}));

vi.mock("../auth/openai-env.js", () => ({
  OpenAIEnvAuth: function OpenAIEnvAuth() {
    return { kind: "api-key", providerId: "openai", headers: async () => ({}), isAuthenticated: async () => true };
  },
}));

vi.mock("../session/store.js", () => ({
  SessionStore: function SessionStore() {
    return {
      resolveLatest: vi.fn().mockResolvedValue("session-abc"),
      buildSnapshot: vi.fn().mockReturnValue({ engineId: "claude-agent-sdk", data: { sessionId: "session-abc" } }),
    };
  },
}));

vi.mock("../ui/headless.js", () => ({
  runHeadless: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ui/repl/index.js", () => ({
  runRepl: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("main", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("help → returns 0 and prints help text", async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { main } = await import("./main.js");
    const code = await main(["help"]);

    expect(code).toBe(0);
    expect(chunks.join("")).toContain("swarm-coder");
  });

  it("version → returns 0 and prints version", async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    const { main } = await import("./main.js");
    const code = await main(["version"]);

    expect(code).toBe(0);
    expect(chunks.join("")).toMatch(/\d+\.\d+\.\d+/);
  });

  it("doctor → delegates to runDoctor with correct outputFormat", async () => {
    const { main } = await import("./main.js");
    const { runDoctor } = await import("./doctor.js");

    await main(["doctor", "--output-format", "json"]);

    expect(runDoctor).toHaveBeenCalledWith("json");
  });

  it("init → delegates to runInit with process.cwd() when no path given", async () => {
    const { main } = await import("./main.js");
    const { runInit } = await import("./init.js");

    await main(["init"]);

    expect(runInit).toHaveBeenCalledWith(process.cwd());
  });

  it("error → returns 2 and prints message", async () => {
    const errChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    });

    const { main } = await import("./main.js");
    const code = await main(["--unknown-flag-xyz", "hello"]);

    expect(code).toBe(2);
    expect(errChunks.join("")).toContain("unknown flag");
  });

  it("prompt → calls runHeadless when --headless flag is set", async () => {
    const { main } = await import("./main.js");
    const { runHeadless } = await import("../ui/headless.js");

    // Stub isTTY so we can test headless flag directly.
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    await main(["--headless", "say hi"]);

    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });

    expect(runHeadless).toHaveBeenCalled();
  });

  it("prompt → calls runRepl when stdout is a TTY and --headless is not set", async () => {
    const { main } = await import("./main.js");
    const { runRepl } = await import("../ui/repl/index.js");

    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    await main(["say hi"]);

    expect(runRepl).toHaveBeenCalled();
  });

  it("prompt → auth failure returns 1 with error message", async () => {
    const { detectAuth } = await import("../auth/status.js");
    (detectAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "none" });

    const errChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    });

    const { main } = await import("./main.js");
    const code = await main(["say hi"]);

    expect(code).toBe(1);
    expect(errChunks.join("")).toContain("no auth found");
  });

  // ---- --dump-engine (M4a Phase 6) ----------------------------------------

  it("--model gpt-4o --framework auto --dump-engine → JSON with engineId:native, providerId:openai", async () => {
    const { resolveProvider } = await import("../providers/routing.js");
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      kind: "native",
      providerFactory: async () => ({ id: "openai", model: {}, capabilities: {}, stream: async function* () {} }),
      modelId: "gpt-4o",
    });

    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { main } = await import("./main.js");
    const code = await main(["--model", "gpt-4o", "--framework", "auto", "--dump-engine", "--headless", "say hi"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("").trim());
    expect(parsed.engineId).toBe("native");
    expect(parsed.providerId).toBe("openai");
    expect(parsed.modelId).toBe("gpt-4o");
  });

  // ---- Phase 7: plugin / login / logout routing ---------------------------

  it("plugin install . → pluginMain invoked with ['install', '.'], exit code honored", async () => {
    const { pluginMain } = await import("./plugin.js");
    (pluginMain as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);

    const { main } = await import("./main.js");
    const code = await main(["plugin", "install", "."]);

    expect(code).toBe(0);
    expect(pluginMain).toHaveBeenCalledWith(["install", "."]);
  });

  it("plugin install . non-zero exit → propagated from pluginMain", async () => {
    const { pluginMain } = await import("./plugin.js");
    (pluginMain as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const { main } = await import("./main.js");
    const code = await main(["plugin", "install", "."]);

    expect(code).toBe(1);
  });

  it("logout --provider codex-chatgpt → logoutMain invoked", async () => {
    const { logoutMain } = await import("./logout.js");
    (logoutMain as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);

    const { main } = await import("./main.js");
    const code = await main(["logout", "--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(logoutMain).toHaveBeenCalledWith(["--provider", "codex-chatgpt"]);
  });

  it("login --provider codex-chatgpt → loginMain invoked", async () => {
    const { loginMain } = await import("./login.js");
    (loginMain as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);

    const { main } = await import("./main.js");
    const code = await main(["login", "--provider", "codex-chatgpt"]);

    expect(code).toBe(0);
    expect(loginMain).toHaveBeenCalledWith(["--provider", "codex-chatgpt"]);
  });

  it("--framework codex-chatgpt → exit 2 with 'not yet wired' error text", async () => {
    const errChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    });
    // process.exit will throw in tests — catch it.
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });

    const { main } = await import("./main.js");
    await expect(main(["--framework", "codex-chatgpt", "--headless", "say hi"])).rejects.toThrow(
      "process.exit(2)",
    );
    expect(errChunks.join("")).toContain("not yet wired");
  });

  it("--framework claude-agent-sdk → filterToolsForFramework called with 'claude-agent-sdk'", async () => {
    const { filterToolsForFramework } = await import("../tools/framework-filter.js");

    const { main } = await import("./main.js");
    await main(["--framework", "claude-agent-sdk", "--headless", "say hi"]);

    expect(filterToolsForFramework).toHaveBeenCalledWith(
      expect.any(Array),
      "claude-agent-sdk",
    );
  });

  it("--model claude-sonnet-4-6 --framework auto --dump-engine → JSON with engineId:claude-agent-sdk", async () => {
    const { resolveProvider } = await import("../providers/routing.js");
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      kind: "sdk",
      engineFactory: () => ({ id: "claude-agent-sdk", capabilities: {}, run: async function* () {} }),
      modelId: "claude-sonnet-4-6",
    });

    const outChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    });

    const { main } = await import("./main.js");
    const code = await main(["--model", "claude-sonnet-4-6", "--framework", "auto", "--dump-engine", "--headless", "say hi"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join("").trim());
    expect(parsed.engineId).toBe("claude-agent-sdk");
    expect(parsed.providerId).toBeUndefined();
    expect(parsed.modelId).toBe("claude-sonnet-4-6");
  });
});
