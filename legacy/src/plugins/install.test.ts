import { describe, it, expect, vi, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { installPlugin, sanitizeId } from "./install.js";
import { PluginStateStore } from "./state.js";

// Mock child_process at module level so ESM doesn't prevent it
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures/plugins");
const HELLO_PLUGIN_DIR = path.join(FIXTURES_DIR, "hello-plugin");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpEnv(): Promise<{ store: PluginStateStore; tmpDir: string; pluginsRoot: string }> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-install-test-"));
  const pluginsRoot = path.join(tmpDir, "plugins");
  const store = new PluginStateStore(tmpDir);
  return { store, tmpDir, pluginsRoot };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("installPlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Local-path install happy path
  it("installs from a local path — target dir exists and state is recorded", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    const result = await installPlugin(
      { kind: "LocalPath", path: HELLO_PLUGIN_DIR },
      { store, pluginsRoot },
    );

    expect(result.id).toBe("hello-plugin");
    expect(result.version).toBe("0.1.0");
    expect(result.installedPath).toContain("hello-plugin");

    const state = await store.read();
    expect(state.versions["hello-plugin"]).toBe("0.1.0");
    expect(state.enabled).toContain("hello-plugin");
  });

  // 2. Manifest missing id field → rejects; staging removed
  it("rejects when plugin.json missing 'id' field", async () => {
    const { store, tmpDir, pluginsRoot } = await makeTmpEnv();

    const srcDir = path.join(tmpDir, "bad-plugin-src");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "plugin.json"), JSON.stringify({
      version: "1.0.0",
      name: "Missing Id",
      execMode: "shell",
      tools: [],
    }));

    await expect(
      installPlugin({ kind: "LocalPath", path: srcDir }, { store, pluginsRoot }),
    ).rejects.toThrow(/missing required field 'id'/);

    // Staging should be cleaned up
    const stagingDir = path.join(pluginsRoot, ".staging");
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(stagingDir);
    } catch {
      // staging dir itself may not exist — that's fine
    }
    expect(entries).toHaveLength(0);
  });

  // 3. Duplicate install → rejects
  it("rejects duplicate install when id already in state.versions", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    await installPlugin({ kind: "LocalPath", path: HELLO_PLUGIN_DIR }, { store, pluginsRoot });
    await expect(
      installPlugin({ kind: "LocalPath", path: HELLO_PLUGIN_DIR }, { store, pluginsRoot }),
    ).rejects.toThrow(/already installed/);
  });

  // 4. Rename failure → staging removed, state unchanged
  // Simulate rename failure by pre-creating the dest as a non-empty directory
  it("cleans up staging on rename failure (dest occupied) and leaves state unchanged", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    // Pre-create dest with contents so rename fails with ENOTEMPTY/EEXIST
    const dest = path.join(pluginsRoot, "hello-plugin");
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, "placeholder.txt"), "occupied");

    await expect(
      installPlugin({ kind: "LocalPath", path: HELLO_PLUGIN_DIR }, { store, pluginsRoot }),
    ).rejects.toThrow();

    const state = await store.read();
    expect(state.versions).toEqual({});

    // Staging cleaned up
    const stagingDir = path.join(pluginsRoot, ".staging");
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(stagingDir);
    } catch {
      // fine
    }
    expect(entries).toHaveLength(0);
  });

  // 5. State has version + source after install
  it("state.installSources records the source after install", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();

    await installPlugin({ kind: "LocalPath", path: HELLO_PLUGIN_DIR }, { store, pluginsRoot });
    const state = await store.read();
    expect(state.installSources["hello-plugin"]).toEqual({
      kind: "LocalPath",
      path: HELLO_PLUGIN_DIR,
    });
  });

  // 6. Id with path traversal → rejects
  it("sanitizeId rejects id containing '..'", () => {
    expect(() => sanitizeId("../../etc/passwd")).toThrow(/path traversal/);
  });

  // 7. sanitizeId replaces / with --
  it("sanitizeId replaces '/' with '--'", () => {
    expect(sanitizeId("publisher/plugin-name")).toBe("publisher--plugin-name");
  });

  // 8. Git-url install (mocked via vi.mock at top)
  it("installs from a git URL using git clone (mocked)", async () => {
    const { store, pluginsRoot } = await makeTmpEnv();
    const cp = await import("node:child_process");

    // Mock execFileSync to materialize a valid plugin.json into the staging dir
    vi.mocked(cp.execFileSync).mockImplementation((_cmd, args?: readonly string[]) => {
      const destArg = (args ?? [])[(args ?? []).length - 1] as string;
      const fs = require("node:fs") as typeof import("node:fs");
      fs.mkdirSync(destArg, { recursive: true });
      fs.writeFileSync(
        path.join(destArg, "plugin.json"),
        JSON.stringify({ id: "hello-plugin", version: "0.1.0", name: "Hello Plugin", execMode: "shell", tools: [] }),
      );
      return Buffer.from("");
    });

    const result = await installPlugin(
      { kind: "GitUrl", url: "https://example.com/hello-plugin.git" },
      { store, pluginsRoot },
    );
    expect(result.id).toBe("hello-plugin");
    expect(result.version).toBe("0.1.0");
  });
});
