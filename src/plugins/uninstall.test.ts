import { describe, it, expect, vi, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { installPlugin } from "./install.js";
import { uninstallPlugin } from "./uninstall.js";
import { PluginStateStore } from "./state.js";
import type { PluginInstallSource } from "./index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures/plugins");
const HELLO_PLUGIN_DIR = path.join(FIXTURES_DIR, "hello-plugin");

async function makeTmpEnv(): Promise<{ store: PluginStateStore; tmpDir: string; pluginsRoot: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-uninstall-test-"));
  const pluginsRoot = path.join(tmpDir, "plugins");
  const store = new PluginStateStore(tmpDir);
  return { store, tmpDir, pluginsRoot };
}

describe("uninstallPlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Uninstall happy path
  it("removes plugin dir and clears state entries", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    await installPlugin({ kind: "LocalPath", path: HELLO_PLUGIN_DIR }, { store, pluginsRoot });

    let state = await store.read();
    expect(state.versions["hello-plugin"]).toBe("0.1.0");

    await uninstallPlugin("hello-plugin", { store, pluginsRoot });

    state = await store.read();
    expect("hello-plugin" in state.versions).toBe(false);
    expect(state.enabled).not.toContain("hello-plugin");
    expect("hello-plugin" in state.installSources).toBe(false);

    // Directory should be gone
    const pluginDir = path.join(pluginsRoot, "hello-plugin");
    await expect(fsp.access(pluginDir)).rejects.toThrow();
  });

  // 2. Idempotent re-uninstall
  it("second uninstall does not throw (idempotent)", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    await expect(uninstallPlugin("hello-plugin", { store, pluginsRoot })).resolves.not.toThrow();
    await expect(uninstallPlugin("hello-plugin", { store, pluginsRoot })).resolves.not.toThrow();
  });

  // 3. State entries removed
  it("removes all three state entries: enabled, versions, installSources", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    const source: PluginInstallSource = { kind: "LocalPath", path: HELLO_PLUGIN_DIR };
    await store.write({
      schemaVersion: 1,
      enabled: ["hello-plugin"],
      versions: { "hello-plugin": "0.1.0" },
      installSources: { "hello-plugin": source },
    });

    await uninstallPlugin("hello-plugin", { store, pluginsRoot });

    const state = await store.read();
    expect(state.enabled).toEqual([]);
    expect(state.versions).toEqual({});
    expect(state.installSources).toEqual({});
  });
});
