import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginStateStore } from "./state.js";
import { enablePlugin } from "./enable.js";
import { disablePlugin } from "./disable.js";
import type { PluginInstallSource } from "./index.js";

const SOURCE: PluginInstallSource = { kind: "LocalPath", path: "/tmp/test-plugin" };

async function makeTmpStore(): Promise<PluginStateStore> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-enable-test-"));
  return new PluginStateStore(path.join(dir, "state.json"));
}

describe("enablePlugin / disablePlugin", () => {
  // 1. enable-when-installed works
  it("enablePlugin enables a disabled installed plugin", async () => {
    const store = await makeTmpStore();
    // Install with disabled state
    await store.write({
      schemaVersion: 1,
      enabled: [],
      versions: { "test-plugin": "1.0.0" },
      installSources: { "test-plugin": SOURCE },
    });
    await enablePlugin("test-plugin", store);
    const state = await store.read();
    expect(state.enabled).toContain("test-plugin");
  });

  // 2. disable-when-enabled works
  it("disablePlugin disables an enabled installed plugin", async () => {
    const store = await makeTmpStore();
    await store.write({
      schemaVersion: 1,
      enabled: ["test-plugin"],
      versions: { "test-plugin": "1.0.0" },
      installSources: { "test-plugin": SOURCE },
    });
    await disablePlugin("test-plugin", store);
    const state = await store.read();
    expect(state.enabled).not.toContain("test-plugin");
  });

  // 3. enable-when-not-installed throws
  it("enablePlugin throws when plugin is not installed", async () => {
    const store = await makeTmpStore();
    await expect(enablePlugin("not-installed", store)).rejects.toThrow(/not installed/);
  });

  // 4. disablePlugin throws when plugin is not installed
  it("disablePlugin throws when plugin is not installed", async () => {
    const store = await makeTmpStore();
    await expect(disablePlugin("not-installed", store)).rejects.toThrow(/not installed/);
  });
});
