import { describe, it, expect, vi, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { PluginRegistry } from "./registry.js";
import { PluginStateStore } from "./state.js";
import type { PluginSource, PluginManifest, LoadedPlugin } from "./index.js";
import { ClaudeCodeSource } from "./claude-code-source.js";

// ---------------------------------------------------------------------------
// Fake in-memory PluginSource helpers
// ---------------------------------------------------------------------------

function makeManifest(
  id: string,
  tools: Array<{ name: string; description?: string }> = [],
  sourceId = "fake",
): PluginManifest {
  return {
    id,
    name: id,
    version: "0.1.0",
    sourceId,
    rootPath: `/fake/${id}`,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? `tool ${t.name}`,
      inputSchema: { type: "object" },
      requiredPermission: "exec" as const,
      command: [],
    })),
    execMode: "in-process",
  };
}

function makeLoadedPlugin(
  manifest: PluginManifest,
  executeResult: Record<string, unknown> = { status: "ok", output: "ok" },
): LoadedPlugin {
  return {
    manifest,
    executeTool: async (_toolName, _input, _ctx) =>
      executeResult as { status: "ok"; output: string },
    dispose: async () => {},
  };
}

class FakeSource implements PluginSource {
  readonly id: string;
  private readonly manifests: PluginManifest[];
  private readonly loadedPlugins: Map<string, LoadedPlugin>;
  private shouldThrowOnDiscover: boolean;

  constructor(
    id: string,
    manifests: PluginManifest[] = [],
    loadOverrides: Map<string, LoadedPlugin> = new Map(),
    shouldThrowOnDiscover = false,
  ) {
    this.id = id;
    this.manifests = manifests;
    this.loadedPlugins = loadOverrides;
    this.shouldThrowOnDiscover = shouldThrowOnDiscover;
  }

  async discover(): Promise<readonly PluginManifest[]> {
    if (this.shouldThrowOnDiscover) throw new Error("discover failed");
    return this.manifests;
  }

  async load(pluginId: string): Promise<LoadedPlugin> {
    if (this.loadedPlugins.has(pluginId)) {
      return this.loadedPlugins.get(pluginId)!;
    }
    const manifest = this.manifests.find((m) => m.id === pluginId);
    if (!manifest) throw new Error(`plugin '${pluginId}' not found`);
    return makeLoadedPlugin(manifest);
  }
}

// ---------------------------------------------------------------------------
// Tests: core registry behaviour
// ---------------------------------------------------------------------------

describe("PluginRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Empty registry
  it("discover() returns [] when no sources are registered", async () => {
    const registry = new PluginRegistry();
    const manifests = await registry.discover();
    expect(manifests).toEqual([]);
  });

  // 2. Single source with 2 manifests
  it("discover() returns both manifests from a single source", async () => {
    const registry = new PluginRegistry();
    const m1 = makeManifest("plugin-a", [{ name: "tool1" }]);
    const m2 = makeManifest("plugin-b", [{ name: "tool2" }]);
    registry.registerSource(new FakeSource("s1", [m1, m2]));

    const manifests = await registry.discover();
    expect(manifests).toHaveLength(2);
    expect(manifests.map((m) => m.id).sort()).toEqual(["plugin-a", "plugin-b"]);
  });

  // 3. Two sources with overlapping ids — first-wins
  it("discover() deduplicates by manifest.id — first source wins", async () => {
    const registry = new PluginRegistry();
    const m1 = makeManifest("shared-plugin", [{ name: "tool-from-s1" }], "s1");
    const m2 = makeManifest("shared-plugin", [{ name: "tool-from-s2" }], "s2");
    registry.registerSource(new FakeSource("s1", [m1]));
    registry.registerSource(new FakeSource("s2", [m2]));

    const manifests = await registry.discover();
    expect(manifests).toHaveLength(1);
    // first-wins: m1 from s1
    expect(manifests[0]!.sourceId).toBe("s1");
    expect(manifests[0]!.tools![0]!.name).toBe("tool-from-s1");
  });

  // 4. load() with unknown id → throws
  it("load() throws when plugin id is unknown across all sources", async () => {
    const registry = new PluginRegistry();
    registry.registerSource(new FakeSource("s1", [makeManifest("plugin-a")]));

    await expect(registry.load("does-not-exist")).rejects.toThrow(
      /not found in any registered source/,
    );
  });

  // 5. buildPluginTools() prefixes names as plugin__<id>__<tool>
  it("buildPluginTools() prefixes tool names correctly", async () => {
    const registry = new PluginRegistry();
    const manifest = makeManifest("my-plugin", [
      { name: "do-thing", description: "does a thing" },
    ]);
    registry.registerSource(new FakeSource("s1", [manifest]));

    const tools = await registry.buildPluginTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.spec.name).toBe("plugin__my-plugin__do-thing");
    expect(tools[0]!.spec.description).toBe("does a thing");
    expect(tools[0]!.spec.tier).toBe(3);
  });

  // 6. Plugin load failure in buildPluginTools() → fail-soft
  it("buildPluginTools() skips plugins that fail to load and emits stderr warning", async () => {
    const registry = new PluginRegistry();

    const goodManifest = makeManifest("good-plugin", [{ name: "ok-tool" }]);
    const badManifest = makeManifest("bad-plugin", [{ name: "bad-tool" }]);

    // bad-plugin's load() throws
    const badLoads = new Map<string, LoadedPlugin>();
    const source = new FakeSource("s1", [goodManifest, badManifest], badLoads);
    // Override load to throw for bad-plugin
    const origLoad = source.load.bind(source);
    source.load = async (id: string) => {
      if (id === "bad-plugin") throw new Error("import failed");
      return origLoad(id);
    };

    const stderrSpy = vi.spyOn(process.stderr, "write");
    registry.registerSource(source);

    const tools = await registry.buildPluginTools();

    // good-plugin's tool registered, bad-plugin skipped
    expect(tools.map((t) => t.spec.name)).toContain("plugin__good-plugin__ok-tool");
    expect(tools.map((t) => t.spec.name)).not.toContain("plugin__bad-plugin__bad-tool");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to load plugin 'bad-plugin'"),
    );
  });

  // 7. Tool name collision → second skipped with warning
  it("buildPluginTools() skips duplicate tool names and emits collision warning", async () => {
    const registry = new PluginRegistry();

    // Two different plugins that both contribute a tool that would produce the
    // same prefixed name — actually they need the same plugin id for the same
    // prefixed name. Use two sources with same plugin id but different tools
    // that happen to produce the same prefixed name is impossible with valid ids.
    // Instead: simulate collision by having two manifests under one source
    // but we can test collision across sources more directly by using
    // the same plugin id in a custom source that returns two tools with
    // the same name from the same manifest.

    // The collision path: same plugin id + same tool name from two different
    // sources both winning for different plugins that share a name prefix.
    // Simplest: create one source where the loaded plugin internally collides.
    // Actually the collision guard fires when registeredNames already has the prefixed name.
    // This happens if we have the exact same plugin__id__tool from two different manifests,
    // which requires the same id+toolName — impossible across different manifests normally.
    // The realistic collision is: one source registers plugin-a/echo, second source
    // also registers plugin-a/echo (same plugin id, same tool).
    // With first-wins dedup on manifest.id, source 2's manifest never appears.
    // So the collision is within a single manifest that somehow lists the same tool twice.

    const manifest = makeManifest("dup-plugin", []);
    // Manually add duplicate tool names to the tools array
    (manifest.tools as Array<{ name: string; description: string; inputSchema: { type: string }; requiredPermission: "exec"; command: never[] }>).push(
      { name: "same-tool", description: "first", inputSchema: { type: "object" }, requiredPermission: "exec", command: [] },
      { name: "same-tool", description: "second", inputSchema: { type: "object" }, requiredPermission: "exec", command: [] },
    );

    const stderrSpy = vi.spyOn(process.stderr, "write");
    registry.registerSource(new FakeSource("s1", [manifest]));

    const tools = await registry.buildPluginTools();

    // Only one tool registered
    const names = tools.map((t) => t.spec.name);
    expect(names.filter((n) => n === "plugin__dup-plugin__same-tool")).toHaveLength(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("plugin tool collision: plugin__dup-plugin__same-tool"),
    );
  });

  // registerSource is idempotent
  it("registerSource() is idempotent — same instance registered twice has no effect", async () => {
    const registry = new PluginRegistry();
    const src = new FakeSource("s1", [makeManifest("plugin-x", [{ name: "t" }])]);
    registry.registerSource(src);
    registry.registerSource(src); // duplicate

    const manifests = await registry.discover();
    expect(manifests).toHaveLength(1); // not doubled
  });

  // buildPluginTools() execute wrapper calls executeTool correctly
  it("buildPluginTools() execute wrapper forwards input to executeTool", async () => {
    const registry = new PluginRegistry();
    const manifest = makeManifest("fwd-plugin", [{ name: "fwd" }]);
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const loaded: LoadedPlugin = {
      manifest,
      executeTool: async (toolName, input, _ctx) => {
        calls.push({ toolName, input });
        return { status: "ok", output: "forwarded" };
      },
      dispose: async () => {},
    };
    const src = new FakeSource("s1", [manifest], new Map([["fwd-plugin", loaded]]));
    registry.registerSource(src);

    const tools = await registry.buildPluginTools();
    expect(tools).toHaveLength(1);

    const result = await tools[0]!.execute({ key: "val" }, { cwd: "/tmp" });
    expect(result).toEqual({ status: "ok", output: "forwarded" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("fwd");
    expect(calls[0]!.input).toEqual({ key: "val" });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ClaudeCodeSource + real fixtures
// ---------------------------------------------------------------------------

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures/plugins");

describe("PluginRegistry integration (ClaudeCodeSource + fixtures)", () => {
  it("discovers shell-plugin and node-plugin from fixtures dir", async () => {
    const registry = new PluginRegistry();
    registry.registerSource(
      new ClaudeCodeSource({ pluginsDir: FIXTURES_DIR }),
    );

    const manifests = await registry.discover();
    const ids = manifests.map((m) => m.id);
    expect(ids).toContain("shell-plugin");
    expect(ids).toContain("node-plugin");
  });

  it("buildPluginTools() produces plugin__shell-plugin__echo and plugin__node-plugin__greet", async () => {
    const registry = new PluginRegistry();
    registry.registerSource(
      new ClaudeCodeSource({ pluginsDir: FIXTURES_DIR }),
    );

    const tools = await registry.buildPluginTools();
    const names = tools.map((t) => t.spec.name);
    expect(names).toContain("plugin__shell-plugin__echo");
    expect(names).toContain("plugin__node-plugin__greet");
  });

  it("greet tool returns {status:'ok', output:'hello there'}", async () => {
    const registry = new PluginRegistry();
    registry.registerSource(
      new ClaudeCodeSource({ pluginsDir: FIXTURES_DIR }),
    );

    const tools = await registry.buildPluginTools();
    const greet = tools.find((t) => t.spec.name === "plugin__node-plugin__greet");
    expect(greet).toBeDefined();

    const result = await greet!.execute({ who: "there" }, { cwd: process.cwd() });
    expect(result).toEqual({ status: "ok", output: "hello there" });
  });

  it("shell-plugin echo tool returns a response (may skip on bash-less systems)", async () => {
    // Skip on Windows where bash is unavailable.
    if (process.platform === "win32") {
      console.log("Skipping shell-plugin test on Windows");
      return;
    }

    const registry = new PluginRegistry();
    registry.registerSource(
      new ClaudeCodeSource({ pluginsDir: FIXTURES_DIR }),
    );

    const tools = await registry.buildPluginTools();
    const echo = tools.find((t) => t.spec.name === "plugin__shell-plugin__echo");
    expect(echo).toBeDefined();

    const result = await echo!.execute({ msg: "hello" }, { cwd: process.cwd() });
    // shell plugin may return ok or error depending on env, but should not throw
    expect(["ok", "error"]).toContain(result.status);
    if (result.status === "ok") {
      expect(result.output).toContain("shell-plugin echo");
    }
  });
});

// ---------------------------------------------------------------------------
// PluginRegistry + PluginStateStore filtering (M4b Phase 3)
// ---------------------------------------------------------------------------

async function makeTmpStore(
  enabled: string[],
  versions: Record<string, string>,
): Promise<PluginStateStore> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-registry-state-test-"));
  const store = new PluginStateStore(dir);
  const sources: Record<string, import("./index.js").PluginInstallSource> = {};
  for (const id of Object.keys(versions)) {
    sources[id] = { kind: "LocalPath", path: `/fake/${id}` };
  }
  await store.write({ schemaVersion: 1, enabled, versions, installSources: sources });
  return store;
}

describe("PluginRegistry with PluginStateStore filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buildPluginTools() registers tools for all enabled plugins", async () => {
    const m1 = makeManifest("plugin-a", [{ name: "tool-a" }]);
    const m2 = makeManifest("plugin-b", [{ name: "tool-b" }]);

    const store = await makeTmpStore(
      ["plugin-a", "plugin-b"],
      { "plugin-a": "1.0.0", "plugin-b": "1.0.0" },
    );

    const registry = new PluginRegistry(store);
    registry.registerSource(new FakeSource("s1", [m1, m2]));

    const tools = await registry.buildPluginTools();
    const names = tools.map((t) => t.spec.name);
    expect(names).toContain("plugin__plugin-a__tool-a");
    expect(names).toContain("plugin__plugin-b__tool-b");
  });

  it("buildPluginTools() skips disabled plugin tools", async () => {
    const m1 = makeManifest("plugin-a", [{ name: "tool-a" }]);
    const m2 = makeManifest("plugin-b", [{ name: "tool-b" }]);

    // Only plugin-a is enabled; plugin-b is disabled
    const store = await makeTmpStore(
      ["plugin-a"],
      { "plugin-a": "1.0.0", "plugin-b": "1.0.0" },
    );

    const stderrSpy = vi.spyOn(process.stderr, "write");
    const registry = new PluginRegistry(store);
    registry.registerSource(new FakeSource("s1", [m1, m2]));

    const tools = await registry.buildPluginTools();
    const names = tools.map((t) => t.spec.name);
    expect(names).toContain("plugin__plugin-a__tool-a");
    expect(names).not.toContain("plugin__plugin-b__tool-b");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("plugin-b"),
    );
  });
});
