/**
 * PluginSource — where plugins come from.
 *
 * Plugins in Claude Code are JSON-manifest-declared packages that bring
 * tools, commands, and optional hooks.
 * They execute tools as subprocesses with a specific env contract.
 *
 * v0 ships a single `claude-code` source (read-only discovery).
 * M4 adds install/enable/disable/update/uninstall lifecycle.
 * Additional sources (e.g. remote registries) can register later
 * without breaking consumers.
 *
 * Separate from SkillSource — manifest, invocation, and lifecycle differ.
 */

import type { JsonSchema, RequiredPermission } from "../core/types.js";

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export interface PluginSource {
  /** Stable source id — "claude-code" | … */
  readonly id: string;

  /** Enumerate available plugins without loading them. */
  discover(): Promise<readonly PluginManifest[]>;

  /** Load a plugin by id. Rejects if the plugin is unknown or invalid. */
  load(pluginId: string): Promise<LoadedPlugin>;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface PluginManifest {
  /** Unique within the source. Typically `<publisher>/<name>`. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;

  /** Which source produced this manifest. Disambiguates cross-source collisions. */
  readonly sourceId: string;
  /** Absolute path to the plugin root on disk. */
  readonly rootPath: string;

  /** Tools this plugin contributes. */
  readonly tools?: readonly PluginToolSpec[];
  /** Slash commands this plugin contributes. */
  readonly commands?: readonly PluginCommandSpec[];
  /** Lifecycle hooks, if any. */
  readonly hooks?: PluginHooksSpec;

  /** Aggregate permissions the plugin has declared. */
  readonly permissions?: readonly RequiredPermission[];

  /**
   * Execution mode for this plugin's tools.
   * - "shell": tools are spawned as subprocesses (the default behavior).
   * - "in-process": tools are loaded from `entryModule` and called directly.
   */
  readonly execMode: "shell" | "in-process";

  /**
   * Path to a Node module that exports `{ buildTools(): ToolImpl[] }`.
   * Required when `execMode === "in-process"`, ignored otherwise.
   */
  readonly entryModule?: string;
}

export interface PluginToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly requiredPermission: RequiredPermission;
  /** Subprocess command the plugin runs to execute this tool. */
  readonly command: readonly string[];
}

export interface PluginCommandSpec {
  readonly name: string;
  readonly description: string;
  readonly command: readonly string[];
}

export interface PluginHooksSpec {
  readonly preToolUse?: readonly string[];
  readonly postToolUse?: readonly string[];
  readonly onSessionStart?: readonly string[];
  readonly onSessionEnd?: readonly string[];
}

// ---------------------------------------------------------------------------
// Loaded plugin
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  readonly manifest: PluginManifest;

  /**
   * Execute one of the plugin's tools.
   * The subprocess receives tool input as JSON on stdin and writes its
   * result to stdout.
   */
  executeTool(
    toolName: string,
    input: unknown,
    context: PluginExecutionContext,
  ): Promise<PluginToolResult>;

  /** Release plugin resources (kill long-running processes, close channels). */
  dispose(): Promise<void>;
}

export interface PluginExecutionContext {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly abort?: AbortSignal;
  /** Environment variables to merge into the subprocess env. */
  readonly env?: Readonly<Record<string, string>>;
}

export type PluginToolResult =
  | { readonly status: "ok"; readonly output: string }
  | {
      readonly status: "error";
      readonly message: string;
      readonly exitCode?: number;
      readonly stderr?: string;
    };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Multiple sources can be registered. Discovery unions across all; load
 * resolves to the first source that knows the id. Collisions are reported.
 */
export interface PluginRegistry {
  register(source: PluginSource): void;
  discover(): Promise<readonly PluginManifest[]>;
  load(pluginId: string): Promise<LoadedPlugin>;
}

// ---------------------------------------------------------------------------
// Install lifecycle (M4b §0.2)
// ---------------------------------------------------------------------------

/**
 * Where a plugin was installed from. Recorded in PluginStateFile so
 * `plugin update` can re-materialize from the same source.
 */
export type PluginInstallSource =
  | { readonly kind: "LocalPath"; readonly path: string }
  | { readonly kind: "GitUrl"; readonly url: string; readonly ref?: string };

/**
 * Persisted plugin state — unified view over two files under
 * `~/.openswarm/plugins/` (doc 17 Q1):
 *   - `settings.json`  — enable map `{ [pluginId]: boolean }`.
 *   - `installed.json` — `{ schemaVersion, plugins: { [id]: { version, installSource } } }`.
 *
 * PluginStateStore.read() merges both files into this flat shape for callers.
 * schemaVersion is load-bearing — readers must refuse unknown versions.
 */
export interface PluginStateFile {
  readonly schemaVersion: 1;
  readonly enabled: readonly string[];
  readonly versions: Readonly<Record<string, string>>;
  readonly installSources: Readonly<Record<string, PluginInstallSource>>;
}
