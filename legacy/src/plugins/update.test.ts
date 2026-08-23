import { describe, it, expect, vi, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { installPlugin } from "./install.js";
import { updatePlugin } from "./update.js";
import { PluginStateStore } from "./state.js";
import type { PluginInstallSource } from "./index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures/plugins");
const HELLO_V1_DIR = path.join(FIXTURES_DIR, "hello-plugin");
const HELLO_V2_DIR = path.join(FIXTURES_DIR, "hello-plugin-v0.2");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpEnv(): Promise<{ store: PluginStateStore; tmpDir: string; pluginsRoot: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-update-test-"));
  const pluginsRoot = path.join(tmpDir, "plugins");
  const store = new PluginStateStore(tmpDir);
  return { store, tmpDir, pluginsRoot };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updatePlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Happy path: install v0.1.0, update to v0.2.0
  it("updates plugin from v0.1.0 to v0.2.0 via a new source path", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    await installPlugin({ kind: "LocalPath", path: HELLO_V1_DIR }, { store, pluginsRoot });

    let state = await store.read();
    expect(state.versions["hello-plugin"]).toBe("0.1.0");

    // Patch source to point at v0.2 fixture
    const v2Source: PluginInstallSource = { kind: "LocalPath", path: HELLO_V2_DIR };
    await store.write({ ...state, installSources: { "hello-plugin": v2Source } });

    const result = await updatePlugin("hello-plugin", { store, pluginsRoot });

    expect(result.oldVersion).toBe("0.1.0");
    expect(result.newVersion).toBe("0.2.0");

    state = await store.read();
    expect(state.versions["hello-plugin"]).toBe("0.2.0");
  });

  // 2. Update when not installed → throws
  it("throws when plugin is not installed", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();
    await expect(updatePlugin("not-installed", { store, pluginsRoot })).rejects.toThrow(/not installed/);
  });

  // 3. Failed manifest validation rolls back
  it("rolls back on invalid manifest in staged update", async () => {
    const { store, tmpDir, pluginsRoot } = await makeTmpEnv();

    await installPlugin({ kind: "LocalPath", path: HELLO_V1_DIR }, { store, pluginsRoot });

    // Create a bad source dir with malformed manifest (missing 'id')
    const badSrc = path.join(tmpDir, "bad-src");
    await fsp.mkdir(badSrc);
    await fsp.writeFile(path.join(badSrc, "plugin.json"), JSON.stringify({ version: "2.0.0", name: "Bad" }));

    const badSource: PluginInstallSource = { kind: "LocalPath", path: badSrc };
    const state = await store.read();
    await store.write({ ...state, installSources: { "hello-plugin": badSource } });

    await expect(updatePlugin("hello-plugin", { store, pluginsRoot })).rejects.toThrow(/missing required field/);

    // State version should still be 0.1.0
    const finalState = await store.read();
    expect(finalState.versions["hello-plugin"]).toBe("0.1.0");
  });

  // 4. Rename failure: old backup dir already exists → rename current→.old fails
  it("throws when plugin dir cannot be renamed (already-occupied .old dir)", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    await installPlugin({ kind: "LocalPath", path: HELLO_V1_DIR }, { store, pluginsRoot });

    const v2Source: PluginInstallSource = { kind: "LocalPath", path: HELLO_V2_DIR };
    const state = await store.read();
    await store.write({ ...state, installSources: { "hello-plugin": v2Source } });

    // Pre-create the .old dir so rename of current→.old fails
    const oldPath = path.join(pluginsRoot, "hello-plugin.old");
    await fsp.mkdir(oldPath, { recursive: true });
    await fsp.writeFile(path.join(oldPath, "blocker.txt"), "occupied");

    await expect(updatePlugin("hello-plugin", { store, pluginsRoot })).rejects.toThrow();
  });

  // 5. Source is re-recorded after successful update
  it("records new installSources entry after update", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    await installPlugin({ kind: "LocalPath", path: HELLO_V1_DIR }, { store, pluginsRoot });

    const v2Source: PluginInstallSource = { kind: "LocalPath", path: HELLO_V2_DIR };
    const state = await store.read();
    await store.write({ ...state, installSources: { "hello-plugin": v2Source } });

    await updatePlugin("hello-plugin", { store, pluginsRoot });

    const finalState = await store.read();
    expect(finalState.installSources["hello-plugin"]).toEqual(v2Source);
  });
});
