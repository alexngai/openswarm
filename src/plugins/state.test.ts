import { describe, it, expect, beforeEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginStateStore } from "./state.js";
import type { PluginInstallSource } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpStore(): Promise<{ store: PluginStateStore; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));
  const store = new PluginStateStore(dir);
  return { store, dir };
}

const LOCAL_SOURCE: PluginInstallSource = { kind: "LocalPath", path: "/tmp/plugin-a" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginStateStore", () => {
  // 1. ENOENT → default empty state
  it("read() returns default empty state when file does not exist", async () => {
    const { store } = await makeTmpStore();
    const state = await store.read();
    expect(state.schemaVersion).toBe(1);
    expect(state.enabled).toEqual([]);
    expect(state.versions).toEqual({});
    expect(state.installSources).toEqual({});
  });

  // 2. Round-trip read/write
  it("write() + read() round-trips state faithfully", async () => {
    const { store } = await makeTmpStore();
    const source: PluginInstallSource = { kind: "LocalPath", path: "/tmp/hello" };
    await store.write({
      schemaVersion: 1,
      enabled: ["plugin-a"],
      versions: { "plugin-a": "1.0.0" },
      installSources: { "plugin-a": source },
    });
    const state = await store.read();
    expect(state.enabled).toEqual(["plugin-a"]);
    expect(state.versions["plugin-a"]).toBe("1.0.0");
    expect(state.installSources["plugin-a"]).toEqual(source);
  });

  // 3. setEnabled idempotent
  it("setEnabled() is idempotent — enabling twice does not duplicate", async () => {
    const { store } = await makeTmpStore();
    // First record to install the plugin
    await store.record("plugin-a", "1.0.0", LOCAL_SOURCE);
    // Disable it so we can test enable
    await store.write({
      schemaVersion: 1,
      enabled: [],
      versions: { "plugin-a": "1.0.0" },
      installSources: { "plugin-a": LOCAL_SOURCE },
    });
    await store.setEnabled("plugin-a", true);
    await store.setEnabled("plugin-a", true); // second enable
    const state = await store.read();
    expect(state.enabled.filter((x) => x === "plugin-a")).toHaveLength(1);
  });

  // 4. record() overwrites version for same id
  it("record() overwrites version for same id", async () => {
    const { store } = await makeTmpStore();
    await store.record("plugin-a", "1.0.0", LOCAL_SOURCE);
    const source2: PluginInstallSource = { kind: "LocalPath", path: "/tmp/plugin-a-v2" };
    await store.record("plugin-a", "2.0.0", source2);
    const state = await store.read();
    expect(state.versions["plugin-a"]).toBe("2.0.0");
    expect(state.installSources["plugin-a"]).toEqual(source2);
    // Still only one entry in enabled
    expect(state.enabled.filter((x) => x === "plugin-a")).toHaveLength(1);
  });

  // 5. remove() deletes from all three maps
  it("remove() deletes from enabled, versions, and installSources", async () => {
    const { store } = await makeTmpStore();
    await store.record("plugin-a", "1.0.0", LOCAL_SOURCE);
    await store.remove("plugin-a");
    const state = await store.read();
    expect(state.enabled).not.toContain("plugin-a");
    expect("plugin-a" in state.versions).toBe(false);
    expect("plugin-a" in state.installSources).toBe(false);
  });

  // 6. Concurrent enable: both survive
  it("concurrent setEnabled calls produce both enables in final state", async () => {
    const { store } = await makeTmpStore();
    // Pre-install both plugins
    await store.write({
      schemaVersion: 1,
      enabled: [],
      versions: { a: "1.0.0", b: "1.0.0" },
      installSources: {
        a: { kind: "LocalPath", path: "/tmp/a" },
        b: { kind: "LocalPath", path: "/tmp/b" },
      },
    });
    await Promise.all([store.setEnabled("a", true), store.setEnabled("b", true)]);
    const state = await store.read();
    expect(state.enabled).toContain("a");
    expect(state.enabled).toContain("b");
  });

  // 7. setEnabled throws when plugin not installed
  it("setEnabled() throws when plugin not in versions", async () => {
    const { store } = await makeTmpStore();
    await expect(store.setEnabled("not-installed", true)).rejects.toThrow(/not installed/);
  });

  // 8. schemaVersion mismatch throws
  it("read() throws on unknown schemaVersion", async () => {
    const { store, dir } = await makeTmpStore();
    const installedFile = path.join(dir, "installed.json");
    await fsp.writeFile(
      installedFile,
      JSON.stringify({ schemaVersion: 99, plugins: {} }),
    );
    await expect(store.read()).rejects.toThrow(/schemaVersion/);
  });

  // 9. settings.json + installed.json layout is on-disk (claw schema)
  it("writes settings.json and installed.json under the root dir", async () => {
    const { store, dir } = await makeTmpStore();
    await store.record("plugin-a", "1.0.0", LOCAL_SOURCE);
    const settingsRaw = await fsp.readFile(path.join(dir, "settings.json"), "utf8");
    const installedRaw = await fsp.readFile(path.join(dir, "installed.json"), "utf8");
    const settings = JSON.parse(settingsRaw) as Record<string, unknown>;
    const installed = JSON.parse(installedRaw) as Record<string, unknown>;
    expect(settings).toEqual({ "plugin-a": true });
    expect(installed).toEqual({
      schemaVersion: 1,
      plugins: {
        "plugin-a": {
          version: "1.0.0",
          installSource: LOCAL_SOURCE,
        },
      },
    });
  });
});
