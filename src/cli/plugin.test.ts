import { describe, it, expect, vi, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { pluginMain, resolveInstallSource } from "./plugin.js";
import { PluginStateStore } from "../plugins/state.js";
import type { PluginInstallSource } from "../plugins/index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// src/cli/ → ../../test/fixtures/plugins
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures/plugins");
const HELLO_PLUGIN_DIR = path.join(FIXTURES_DIR, "hello-plugin");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpEnv(): Promise<{ store: PluginStateStore; tmpDir: string; pluginsRoot: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-cli-plugin-test-"));
  const pluginsRoot = path.join(tmpDir, "plugins");
  const store = new PluginStateStore(path.join(tmpDir, "state.json"));
  return { store, tmpDir, pluginsRoot };
}

// ---------------------------------------------------------------------------
// resolveInstallSource
// ---------------------------------------------------------------------------

describe("resolveInstallSource", () => {
  it("recognizes git+ prefix as GitUrl", () => {
    const src = resolveInstallSource("git+https://example.com/plugin.git");
    expect(src.kind).toBe("GitUrl");
  });

  it("recognizes .git suffix as GitUrl", () => {
    const src = resolveInstallSource("https://example.com/plugin.git");
    expect(src.kind).toBe("GitUrl");
  });

  it("recognizes git@ as GitUrl", () => {
    const src = resolveInstallSource("git@github.com:user/plugin.git");
    expect(src.kind).toBe("GitUrl");
  });

  it("recognizes an existing directory as LocalPath", () => {
    const src = resolveInstallSource(HELLO_PLUGIN_DIR);
    expect(src.kind).toBe("LocalPath");
  });

  it("throws for non-existent path", () => {
    expect(() => resolveInstallSource("/definitely/does/not/exist/xyz")).toThrow(
      /not recognized/,
    );
  });

  it("throws for a file (not a directory)", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-resolve-test-"));
    const filePath = path.join(tmpDir, "not-a-dir.json");
    await fsp.writeFile(filePath, "{}");
    expect(() => resolveInstallSource(filePath)).toThrow(/must be a directory/);
  });
});

// ---------------------------------------------------------------------------
// pluginMain — subcommand tests
// ---------------------------------------------------------------------------

describe("pluginMain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. install local path → succeeds, state updated
  it("install local path → exit 0, state updated", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();
    const code = await pluginMain(["install", HELLO_PLUGIN_DIR], store, pluginsRoot);
    expect(code).toBe(0);
    const state = await store.read();
    expect(state.versions["hello-plugin"]).toBe("0.1.0");
  });

  // 2. install non-existent path → error, exit 1
  it("install non-existent path → exit 1", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();
    const stderrSpy = vi.spyOn(process.stderr, "write");
    const code = await pluginMain(["install", "/does/not/exist"], store, pluginsRoot);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not recognized"));
  });

  // 3. install git URL without trust flag → error about trust
  it("install git URL without --yes-i-trust-this-source → exit 1", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();
    const stderrSpy = vi.spyOn(process.stderr, "write");
    const code = await pluginMain(
      ["install", "https://example.com/plugin.git"],
      store,
      pluginsRoot,
    );
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("untrusted source"),
    );
  });

  // 4. list with one installed plugin → prints table
  it("list with one installed plugin → prints table row", async () => {
    const { store } = await makeTmpEnv();
    const source: PluginInstallSource = { kind: "LocalPath", path: HELLO_PLUGIN_DIR };
    await store.write({
      schemaVersion: 1,
      enabled: ["hello-plugin"],
      versions: { "hello-plugin": "0.1.0" },
      installSources: { "hello-plugin": source },
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const code = await pluginMain(["list"], store);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("hello-plugin");
    expect(output).toContain("0.1.0");
    expect(output).toContain("yes");
  });

  // 5. enable / disable round-trip
  it("enable then disable round-trip → state reflects", async () => {
    const { store } = await makeTmpEnv();
    await store.write({
      schemaVersion: 1,
      enabled: [],
      versions: { "hello-plugin": "0.1.0" },
      installSources: { "hello-plugin": { kind: "LocalPath", path: HELLO_PLUGIN_DIR } },
    });

    let code = await pluginMain(["enable", "hello-plugin"], store);
    expect(code).toBe(0);
    expect((await store.read()).enabled).toContain("hello-plugin");

    code = await pluginMain(["disable", "hello-plugin"], store);
    expect(code).toBe(0);
    expect((await store.read()).enabled).not.toContain("hello-plugin");
  });

  // 6. uninstall → state cleared
  it("uninstall → state cleared, exit 0", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();
    await store.write({
      schemaVersion: 1,
      enabled: ["hello-plugin"],
      versions: { "hello-plugin": "0.1.0" },
      installSources: { "hello-plugin": { kind: "LocalPath", path: HELLO_PLUGIN_DIR } },
    });

    const code = await pluginMain(["uninstall", "hello-plugin"], store, pluginsRoot);
    expect(code).toBe(0);
    const state = await store.read();
    expect("hello-plugin" in state.versions).toBe(false);
  });

  // 7. unknown subcommand → exit 1
  it("unknown subcommand → exit 1", async () => {
    const { store } = await makeTmpEnv();
    const stderrSpy = vi.spyOn(process.stderr, "write");
    const code = await pluginMain(["bogus"], store);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown plugin subcommand"),
    );
  });
});
