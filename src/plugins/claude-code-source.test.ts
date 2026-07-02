import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ClaudeCodeSource } from "./claude-code-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "swc-plugin-"));
}

async function rmDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function writePluginJson(
  pluginsDir: string,
  pluginId: string,
  content: object,
): Promise<void> {
  const dir = path.join(pluginsDir, pluginId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify(content),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeCodeSource", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rmDir(tmpDir);
    vi.restoreAllMocks();
  });

  // 1. Empty plugins dir → discover() returns []
  it("returns [] when plugins dir is empty", async () => {
    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    const manifests = await src.discover();
    expect(manifests).toEqual([]);
  });

  // Non-existent dir → returns []
  it("returns [] when plugins dir does not exist", async () => {
    const src = new ClaudeCodeSource({
      pluginsDir: path.join(tmpDir, "nonexistent"),
    });
    const manifests = await src.discover();
    expect(manifests).toEqual([]);
  });

  // 2. Dir with invalid JSON → warning logged, skipped
  it("skips subdirectory with invalid JSON and logs warning", async () => {
    const dir = path.join(tmpDir, "bad-plugin");
    await fs.promises.mkdir(dir);
    await fs.promises.writeFile(
      path.join(dir, "plugin.json"),
      "{ not valid json",
      "utf8",
    );

    const warnSpy = vi.spyOn(process.stderr, "write");
    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    const manifests = await src.discover();

    expect(manifests).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[openswarm] plugin bad-plugin"),
    );
  });

  // 10. Zod validation: missing execMode → skipped with warning
  it("skips plugin with missing execMode (Zod validation failure)", async () => {
    await writePluginJson(tmpDir, "no-exec-mode", {
      id: "no-exec-mode",
      version: "1.0.0",
      tools: [{ name: "foo" }],
      // execMode intentionally missing
    });

    const warnSpy = vi.spyOn(process.stderr, "write");
    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    const manifests = await src.discover();

    expect(manifests).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[openswarm] plugin no-exec-mode"),
    );
  });

  // 3. Valid shell-mode plugin discovered and loadable
  it("discovers and loads a valid shell-mode plugin", async () => {
    await writePluginJson(tmpDir, "my-shell-plugin", {
      id: "my-shell-plugin",
      version: "1.0.0",
      execMode: "shell",
      tools: [{ name: "greet", description: "says hello" }],
      command: 'echo \'{"status":"ok","output":"hello"}\'',
    });

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    const manifests = await src.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.id).toBe("my-shell-plugin");
    expect(manifests[0]!.execMode).toBe("shell");

    const plugin = await src.load("my-shell-plugin");
    expect(plugin.manifest.id).toBe("my-shell-plugin");
  });

  // 4. Valid in-process plugin discovered and loadable
  it("discovers and loads a valid in-process plugin", async () => {
    const pluginDir = path.join(tmpDir, "my-inproc-plugin");
    await fs.promises.mkdir(pluginDir);
    await fs.promises.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "my-inproc-plugin",
        version: "1.0.0",
        execMode: "in-process",
        tools: [{ name: "echo-tool" }],
        entryModule: "./entry.mjs",
      }),
      "utf8",
    );
    // Write a real ESM entry module
    await fs.promises.writeFile(
      path.join(pluginDir, "entry.mjs"),
      `export function buildTools() {
  return [{
    name: "echo-tool",
    execute: async (input) => ({ status: "ok", output: JSON.stringify(input) }),
  }];
}
`,
      "utf8",
    );

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    const manifests = await src.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.execMode).toBe("in-process");

    const plugin = await src.load("my-inproc-plugin");
    const result = await plugin.executeTool(
      "echo-tool",
      { msg: "hi" },
      { cwd: tmpDir },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("hi");
    }
  });

  // 5. In-process entryModule escapes dir → rejected
  it("rejects in-process plugin whose entryModule escapes plugin directory", async () => {
    await writePluginJson(tmpDir, "evil-plugin", {
      id: "evil-plugin",
      version: "1.0.0",
      execMode: "in-process",
      tools: [{ name: "bad" }],
      entryModule: "../../outside.mjs",
    });

    const src = new ClaudeCodeSource({
      pluginsDir: tmpDir,
      enforceEntryModuleBoundary: true,
    });

    await src.discover();
    await expect(src.load("evil-plugin")).rejects.toThrow(
      /entryModule escapes plugin directory/,
    );
  });

  // 6. In-process plugin throws on import → graceful degradation
  it("returns degraded plugin when in-process entry module fails to import", async () => {
    const pluginDir = path.join(tmpDir, "broken-plugin");
    await fs.promises.mkdir(pluginDir);
    await fs.promises.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "broken-plugin",
        version: "1.0.0",
        execMode: "in-process",
        tools: [{ name: "boom" }],
        entryModule: "./nonexistent-module.mjs",
      }),
      "utf8",
    );

    const warnSpy = vi.spyOn(process.stderr, "write");
    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    await src.discover();

    const plugin = await src.load("broken-plugin");
    expect(plugin.manifest.id).toBe("broken-plugin");

    const result = await plugin.executeTool("boom", {}, { cwd: tmpDir });
    expect(result.status).toBe("error");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[openswarm] plugin broken-plugin"),
    );
  });

  // 7. Shell plugin executes and returns correctly parsed stdout
  it("executes shell plugin and parses JSON stdout", async () => {
    await writePluginJson(tmpDir, "echo-plugin", {
      id: "echo-plugin",
      version: "1.0.0",
      execMode: "shell",
      tools: [{ name: "say" }],
      command: 'echo \'{"status":"ok","output":"world"}\'',
    });

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    await src.discover();
    const plugin = await src.load("echo-plugin");

    const result = await plugin.executeTool("say", {}, { cwd: tmpDir });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("world");
    }
  });

  // 7b. Shell plugin command resolves relative paths against pluginDir
  //     (regression: earlier revisions spawned in process.cwd(), so
  //     manifests like `command: "./run.sh"` failed with "No such file".)
  it("spawns shell plugin with cwd set to the plugin directory", async () => {
    const pluginDir = path.join(tmpDir, "rel-plugin");
    await fs.promises.mkdir(pluginDir, { recursive: true });
    const script = path.join(pluginDir, "run.sh");
    await fs.promises.writeFile(
      script,
      '#!/usr/bin/env bash\necho \'{"status":"ok","output":"rel-ok"}\'\n',
      { mode: 0o755 },
    );
    await fs.promises.chmod(script, 0o755);
    await fs.promises.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "rel-plugin",
        version: "1.0.0",
        execMode: "shell",
        tools: [{ name: "go" }],
        command: "./run.sh",
      }),
    );

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    await src.discover();
    const plugin = await src.load("rel-plugin");

    const result = await plugin.executeTool("go", {}, { cwd: tmpDir });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("rel-ok");
    }
  });

  // 8. Shell plugin non-zero exit → error result
  it("returns error result when shell plugin exits non-zero", async () => {
    await writePluginJson(tmpDir, "fail-plugin", {
      id: "fail-plugin",
      version: "1.0.0",
      execMode: "shell",
      tools: [{ name: "fail" }],
      command: "exit 1",
    });

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    await src.discover();
    const plugin = await src.load("fail-plugin");

    const result = await plugin.executeTool("fail", {}, { cwd: tmpDir });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/plugin exited 1/);
    }
  });

  // 9. Shell plugin timeout → SIGTERM sent and error result
  it("returns error result when shell plugin times out", async () => {
    await writePluginJson(tmpDir, "slow-plugin", {
      id: "slow-plugin",
      version: "1.0.0",
      execMode: "shell",
      tools: [{ name: "slow" }],
      command: "sleep 60",
    });

    // Monkey-patch TIMEOUT_MS by using a very short timeout via the class
    // We test this by patching the source to use 100ms timeout
    // Since TIMEOUT_MS is internal, we'll use a workaround: write a plugin
    // that sleeps 10s and test with a custom source subclass.
    // Instead, directly test with the source and accept it waits 30s...
    // Better: create a subclass exposing timeout for test purposes.
    // Since the spec says "tight timeout in test, e.g. 100ms", we patch the spawn.

    // Approach: use vi.spyOn to intercept child_process.spawn and inject a slow process.
    // Actually the simplest approach: override TIMEOUT_MS by extending the class
    // or just trust the test framework timeout. Let's use a real short sleep with
    // a very short plugin-level timeout injected via a testable subclass approach.

    // Since TIMEOUT_MS is hardcoded at 30s, we need to patch. Let's use a subclass.
    class FastTimeoutSource extends ClaudeCodeSource {
      protected readonly _timeoutMs = 100;
    }

    // That won't work with private. Let's instead just test via a shell command
    // that sleeps briefly and patch via environment — actually, let's just
    // accept the 30s limit and make the test use a mock of child_process.

    // Simplest correct approach: use a real process but mock the timeout.
    // We expose timeout as an option for testability.

    // Since the spec says this test should work with tight timeouts, let's
    // make TIMEOUT_MS configurable via a protected field approach won't work.
    // Use vi.useFakeTimers to advance time.

    vi.useFakeTimers();

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    await src.discover();
    const plugin = await src.load("slow-plugin");

    const resultPromise = plugin.executeTool("slow", {}, { cwd: tmpDir });

    // Advance fake timers past the 30s timeout
    await vi.advanceTimersByTimeAsync(31_000);

    const result = await resultPromise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("timed out");
    }

    vi.useRealTimers();
  }, 10_000);

  // load() throws for unknown plugin id
  it("throws when loading unknown plugin id", async () => {
    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    await expect(src.load("does-not-exist")).rejects.toThrow(
      /plugin 'does-not-exist' not found/,
    );
  });

  // executeTool returns error for unknown tool name in shell mode
  it("returns error when tool name is not in shell-mode plugin manifest", async () => {
    await writePluginJson(tmpDir, "tool-check-plugin", {
      id: "tool-check-plugin",
      version: "1.0.0",
      execMode: "shell",
      tools: [{ name: "real-tool" }],
      command: 'echo \'{"status":"ok","output":"ok"}\'',
    });

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    await src.discover();
    const plugin = await src.load("tool-check-plugin");

    const result = await plugin.executeTool(
      "fake-tool",
      {},
      { cwd: tmpDir },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("fake-tool");
    }
  });

  // discover() is cached — calling twice returns same result
  it("caches discover() results on second call", async () => {
    await writePluginJson(tmpDir, "cached-plugin", {
      id: "cached-plugin",
      version: "1.0.0",
      execMode: "shell",
      tools: [{ name: "x" }],
      command: "echo ok",
    });

    const src = new ClaudeCodeSource({ pluginsDir: tmpDir });
    const first = await src.discover();
    const second = await src.discover();
    expect(first).toBe(second); // same array reference from cache
  });
});
