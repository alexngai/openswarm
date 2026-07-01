/**
 * PluginRegistry — aggregates multiple PluginSources and registers plugin
 * tools into a ToolDispatcher.
 *
 * Discovery unions across all sources; first-wins deduplication by manifest.id.
 * Load resolves to the first source that knows the id.
 * Plugin load failures are fail-soft: a stderr warning is emitted and the
 * plugin is skipped; other plugins continue to register.
 *
 * Tool name collision policy (rev-2 Major M4): if two plugins contribute a
 * tool with the same prefixed name (`plugin__<id>__<tool>`), the first
 * registered copy wins and a stderr warning identifies the skipped duplicate.
 */

import { z } from "zod";
import type { PluginSource, PluginManifest, LoadedPlugin, PluginExecutionContext } from "./index.js";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../tools/types.js";
import { PluginStateStore, defaultStore } from "./state.js";

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private readonly sources: PluginSource[] = [];
  private _stateStore: PluginStateStore | null = null;

  constructor(stateStore?: PluginStateStore) {
    this._stateStore = stateStore ?? null;
  }

  setStateStore(store: PluginStateStore): void {
    this._stateStore = store;
  }

  /**
   * Register a source. Idempotent by source identity (object reference).
   * Registering the same source instance twice is a no-op.
   */
  registerSource(source: PluginSource): void {
    if (!this.sources.includes(source)) {
      this.sources.push(source);
    }
  }

  /**
   * Discover across all registered sources.
   * Returns a union deduped by manifest.id — first-wins across source order.
   */
  async discover(): Promise<PluginManifest[]> {
    const seen = new Map<string, PluginManifest>();

    for (const source of this.sources) {
      let manifests: readonly PluginManifest[];
      try {
        manifests = await source.discover();
      } catch (err) {
        this._warn(
          `source '${source.id}' discover() threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      for (const manifest of manifests) {
        if (!seen.has(manifest.id)) {
          seen.set(manifest.id, manifest);
        }
        // silently drop duplicates from later sources — first-wins
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Resolve a specific plugin id. First source that discovers it wins.
   * Throws if not found across all sources.
   */
  async load(id: string): Promise<LoadedPlugin> {
    for (const source of this.sources) {
      let manifests: readonly PluginManifest[];
      try {
        manifests = await source.discover();
      } catch {
        continue;
      }

      if (manifests.some((m) => m.id === id)) {
        return source.load(id);
      }
    }

    throw new Error(`plugin '${id}' not found in any registered source`);
  }

  /**
   * Discover + load all + build a ToolImpl array suitable for merging into the
   * host's ToolImpl list.
   *
   * Each produced ToolImpl is prefixed: `plugin__<pluginId>__<toolName>`.
   * Failed plugin loads emit stderr warnings and are skipped (fail-soft).
   * Name collisions between plugin tools: second occurrence is skipped with warning.
   */
  async buildPluginTools(): Promise<ToolImpl[]> {
    // Discover across all sources, tracking which source owns each manifest.id.
    const seen = new Map<string, { manifest: PluginManifest; source: PluginSource }>();

    for (const source of this.sources) {
      let manifests: readonly PluginManifest[];
      try {
        manifests = await source.discover();
      } catch (err) {
        this._warn(
          `source '${source.id}' discover() threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      for (const manifest of manifests) {
        if (!seen.has(manifest.id)) {
          seen.set(manifest.id, { manifest, source });
        }
      }
    }

    // Only filter by enabled-set when a state store was provided AND that
    // store has at least one installed plugin on record. Without a store, or
    // with an empty/uninitialised store, all discovered plugins are treated
    // as enabled:
    //   - pre-M4b callers that never set a store (backward compat)
    //   - fresh installs where `~/.swarm-harness/plugins/` is empty
    //   - integration tests that point SWARM_HARNESS_PLUGINS_DIR at a fixture
    //     tree without a matching settings.json / installed.json
    // Filtering activates once the user has installed at least one plugin
    // through our flow (`openswarm plugin install <src>`).
    let enabledSet: ReadonlySet<string> | null = null;
    if (this._stateStore !== null) {
      try {
        const state = await this._stateStore.read();
        if (Object.keys(state.versions).length > 0) {
          enabledSet = new Set(state.enabled);
        }
      } catch {
        // If state is unreadable, treat all as enabled (graceful degradation).
      }
    }

    const result: ToolImpl[] = [];
    const registeredNames = new Set<string>();

    for (const { manifest, source } of seen.values()) {
      // Skip disabled plugins (only when we have an explicit state store).
      if (enabledSet !== null && !enabledSet.has(manifest.id)) {
        this._warn(`plugin '${manifest.id}' is disabled — skipping`);
        continue;
      }

      let loaded: LoadedPlugin;
      try {
        loaded = await source.load(manifest.id);
      } catch (err) {
        this._warn(
          `failed to load plugin '${manifest.id}': ${err instanceof Error ? err.message : String(err)} — skipping`,
        );
        continue;
      }

      const tools = manifest.tools ?? [];
      for (const toolDescriptor of tools) {
        const prefixedName = `plugin__${manifest.id}__${toolDescriptor.name}`;

        // Collision check.
        if (registeredNames.has(prefixedName)) {
          this._warn(
            `plugin tool collision: ${prefixedName} — keeping first-registered copy from ${source.id}`,
          );
          continue;
        }

        registeredNames.add(prefixedName);

        // Capture loop vars for closure.
        const capturedLoaded = loaded;
        const capturedToolName = toolDescriptor.name;
        const capturedManifestId = manifest.id;

        // Determine requiredPermission — PluginToolSpec has it, but the
        // discover-time manifest.tools may use a simplified descriptor shape.
        // Fall back to "exec" (the default in ClaudeCodeSource._buildManifest).
        const requiredPermission =
          (toolDescriptor as { requiredPermission?: string }).requiredPermission as
            | "none"
            | "read"
            | "write"
            | "exec"
            | "network"
            | undefined ?? "exec";

        const toolImpl: ToolImpl = {
          spec: {
            name: prefixedName,
            description:
              toolDescriptor.description ??
              `Plugin tool from ${capturedManifestId}`,
            inputSchema: (toolDescriptor as { inputSchema?: { type: string } }).inputSchema ?? {
              type: "object",
            },
            requiredPermission,
            tier: 3,
          },
          zodSchema: z.record(z.string(), z.unknown()),
          execute: async (
            input: unknown,
            ctx: ToolExecutionContext,
          ): Promise<ToolResult> => {
            const pluginCtx: PluginExecutionContext = {
              cwd: ctx.cwd,
              abort: ctx.abort,
            };
            const pluginResult = await capturedLoaded.executeTool(
              capturedToolName,
              input,
              pluginCtx,
            );
            if (pluginResult.status === "ok") {
              return { status: "ok", output: pluginResult.output };
            }
            return {
              status: "error",
              message: pluginResult.message,
            };
          },
        };

        result.push(toolImpl);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _warn(msg: string): void {
    process.stderr.write(`[openswarm] ${msg}\n`);
  }
}
