/**
 * ClaudeCodeSource — discovers and loads plugins from a local directory.
 *
 * Default scan path: `~/.claude/plugins/`. Each subdirectory that contains a
 * valid `plugin.json` is surfaced as a PluginManifest. Two execution modes:
 *   - "shell"      : tools run as subprocesses via `bash -c manifest.command`.
 *   - "in-process" : tools are loaded from `entryModule` via dynamic import().
 *
 * @security In-process plugins execute with FULL PROCESS PRIVILEGE — the same
 * Node.js process, same memory, same file-system access, same env vars, same
 * network. There is NO sandbox. Only enable in-process mode for plugins from
 * fully trusted sources (e.g. your own code). The path-traversal guard
 * (`enforceEntryModuleBoundary`) prevents `entryModule` values like `../../evil`
 * from escaping the plugin directory, but it does NOT restrict what the loaded
 * module can do once imported. Keep `enforceEntryModuleBoundary: true` (default)
 * in all production deployments.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import { z } from "zod";
import type {
  PluginSource,
  PluginManifest,
  LoadedPlugin,
  PluginExecutionContext,
  PluginToolResult,
} from "./index.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaudeCodeSourceOptions {
  /**
   * Directory to scan for plugins.
   * Default: `${os.homedir()}/.claude/plugins`
   */
  readonly pluginsDir?: string;
  /**
   * Validation toggle for `entryModule` path-traversal guard. Default: true.
   * Kept configurable ONLY for testing. Never disable in production.
   */
  readonly enforceEntryModuleBoundary?: boolean;
  /**
   * Source id surfaced in PluginManifest.sourceId. Default: "claude-code".
   * Override when registering a second instance that scans
   * `~/.openswarm/plugins/` so PluginRegistry can distinguish origins.
   */
  readonly id?: string;
}

// ---------------------------------------------------------------------------
// Zod schema for plugin.json
// ---------------------------------------------------------------------------

const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  // JSON Schema passed through to the engine so the model sees accurate
  // arg names. Defaults to an empty object schema when omitted.
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  // Permission level declared by the plugin. Defaults to "exec" for shell
  // plugins (they spawn subprocesses) and "none" for simple in-process
  // plugins. Callers can still override via canUseTool.
  requiredPermission: z
    .enum(["none", "read", "write", "exec", "network"])
    .optional(),
});

const PluginJsonSchema = z.object({
  id: z.string(),
  version: z.string(),
  execMode: z.enum(["shell", "in-process"]),
  tools: z.array(ToolDescriptorSchema),
  entryModule: z.string().optional(),
  command: z.string().optional(),
  // Optional display metadata
  name: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
});

type PluginJson = z.infer<typeof PluginJsonSchema>;

// ---------------------------------------------------------------------------
// ToolImpl interface expected from in-process entry modules
// ---------------------------------------------------------------------------

interface ToolImpl {
  name: string;
  execute(
    input: unknown,
    ctx: PluginExecutionContext,
  ): Promise<PluginToolResult>;
}

interface PluginEntryModule {
  buildTools(): ToolImpl[];
}

// ---------------------------------------------------------------------------
// ClaudeCodeSource
// ---------------------------------------------------------------------------

export class ClaudeCodeSource implements PluginSource {
  readonly id: string;

  private readonly pluginsDir: string;
  private readonly enforceEntryModuleBoundary: boolean;

  // One-shot manifest cache — populated on first discover() call.
  private _manifestCache: Map<string, PluginManifest> | null = null;
  // Stable array returned by every discover() call after the first.
  private _manifestArray: readonly PluginManifest[] | null = null;

  constructor(opts?: ClaudeCodeSourceOptions) {
    // Priority: explicit opts.pluginsDir > OPENSWARM_PLUGINS_DIR env > default.
    // The env override is for testing / smoke scripts only — not a production
    // config surface. It lets integration tests point at fixture plugin trees
    // without touching the user's real `~/.claude/plugins`.
    const envDir = process.env.OPENSWARM_PLUGINS_DIR;
    this.pluginsDir =
      opts?.pluginsDir ??
      (envDir !== undefined && envDir.length > 0
        ? envDir
        : path.join(os.homedir(), ".claude", "plugins"));
    this.enforceEntryModuleBoundary =
      opts?.enforceEntryModuleBoundary ?? true;
    this.id = opts?.id ?? "claude-code";
  }

  // ---------------------------------------------------------------------------
  // discover
  // ---------------------------------------------------------------------------

  async discover(): Promise<readonly PluginManifest[]> {
    if (this._manifestCache !== null) {
      return this._manifestArray!;
    }

    const cache = new Map<string, PluginManifest>();

    // Fail-soft if directory doesn't exist.
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.pluginsDir, {
        withFileTypes: true,
      });
    } catch {
      this._manifestCache = cache;
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(this.pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.json");

      let raw: string;
      try {
        raw = await fs.promises.readFile(manifestPath, "utf8");
      } catch {
        // No plugin.json — skip silently.
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        this._warn(entry.name, `plugin.json is not valid JSON: ${String(err)}`);
        continue;
      }

      const result = PluginJsonSchema.safeParse(parsed);
      if (!result.success) {
        this._warn(entry.name, result.error.message);
        continue;
      }

      const pj = result.data;
      const manifest = this._buildManifest(pj, pluginDir);
      cache.set(manifest.id, manifest);
    }

    this._manifestCache = cache;
    this._manifestArray = Array.from(cache.values());
    return this._manifestArray;
  }

  // ---------------------------------------------------------------------------
  // load
  // ---------------------------------------------------------------------------

  async load(pluginId: string): Promise<LoadedPlugin> {
    // Ensure the cache is populated.
    await this.discover();

    const manifest = this._manifestCache!.get(pluginId);
    if (!manifest) {
      throw new Error(`plugin '${pluginId}' not found`);
    }

    const pluginDir = path.join(this.pluginsDir, pluginId);

    if (manifest.execMode === "shell") {
      return this._loadShell(manifest, pluginDir);
    } else {
      return this._loadInProcess(manifest, pluginDir);
    }
  }

  // ---------------------------------------------------------------------------
  // Shell mode
  // ---------------------------------------------------------------------------

  private _loadShell(
    manifest: PluginManifest,
    pluginDir: string,
  ): LoadedPlugin {
    const toolNames = new Set((manifest.tools ?? []).map((t) => t.name));
    const command = (manifest as PluginManifest & { command?: string }).command;

    const executeTool = async (
      toolName: string,
      input: unknown,
      _ctx: PluginExecutionContext,
    ): Promise<PluginToolResult> => {
      if (!toolNames.has(toolName)) {
        return {
          status: "error",
          message: `tool '${toolName}' not found in plugin '${manifest.id}'`,
        };
      }

      const shellCommand = command ?? toolName;

      // Environment: inherit process.env only. The plugin receives its tool
      // input as JSON on stdin (below); no extra context env vars are set.
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      );

      return new Promise<PluginToolResult>((resolve) => {
        const TIMEOUT_MS = 30_000;
        const ac = new AbortController();
        const timer = setTimeout(() => {
          ac.abort();
          resolve({ status: "error", message: "plugin timed out after 30s" });
        }, TIMEOUT_MS);

        // Use `bash -c` for shell compatibility.
        // cwd: pluginDir so the manifest's `command` can use paths relative
        // to its own directory (e.g., "./run.sh").
        const child = cp.spawn("bash", ["-c", shellCommand], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          signal: ac.signal,
          cwd: pluginDir,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

        // Write input JSON to stdin and close.
        //
        // A plugin is free to ignore stdin — `echo '{...}'` never reads it. If
        // it exits first the pipe is already gone and this write raises EPIPE
        // on the stream. With no "error" listener that becomes an uncaught
        // exception and takes the host down, even though the plugin ran fine
        // and its result is captured below. Swallow it: the child's real
        // outcome arrives on "close", via exit code and stderr.
        child.stdin.on("error", () => {});
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();

        child.on("close", (code) => {
          clearTimeout(timer);
          if (ac.signal.aborted) return; // timeout already resolved

          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const stderr = Buffer.concat(stderrChunks)
            .toString("utf8")
            .slice(0, 500);

          if (code === 0) {
            try {
              const parsed = JSON.parse(stdout) as PluginToolResult;
              resolve(parsed);
            } catch {
              resolve({
                status: "error",
                message: `plugin stdout was not valid JSON: ${stdout.slice(0, 200)}`,
              });
            }
          } else {
            resolve({
              status: "error",
              message: `plugin exited ${code ?? "null"}: ${stderr}`,
              exitCode: code ?? undefined,
              stderr,
            });
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          if (ac.signal.aborted) return;
          resolve({ status: "error", message: `plugin spawn error: ${err.message}` });
        });
      });
    };

    return {
      manifest,
      executeTool,
      dispose: async () => {},
    };
  }

  // ---------------------------------------------------------------------------
  // In-process mode
  // ---------------------------------------------------------------------------

  private async _loadInProcess(
    manifest: PluginManifest,
    pluginDir: string,
  ): Promise<LoadedPlugin> {
    const entryModule = manifest.entryModule;
    if (!entryModule) {
      const msg = `plugin '${manifest.id}' has execMode 'in-process' but no entryModule`;
      this._warn(manifest.id, msg);
      return this._degradedPlugin(manifest, msg);
    }

    // Path-traversal guard.
    if (this.enforceEntryModuleBoundary) {
      const resolved = path.resolve(pluginDir, entryModule);
      const normalizedDir = path.resolve(pluginDir) + path.sep;
      if (!resolved.startsWith(normalizedDir) && resolved !== path.resolve(pluginDir)) {
        const msg = `plugin '${manifest.id}' entryModule escapes plugin directory`;
        process.stderr.write(`[openswarm] ${msg}\n`);
        throw new Error(msg);
      }
    }

    const modulePath = path.resolve(pluginDir, entryModule);

    let mod: PluginEntryModule;
    try {
      mod = (await import(modulePath)) as PluginEntryModule;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const msg = `plugin '${manifest.id}' failed to load at ${entryModule}: ${errMsg}`;
      this._warn(manifest.id, msg);
      return this._degradedPlugin(manifest, msg);
    }

    // Build tools once and cache.
    let tools: ToolImpl[];
    try {
      tools = mod.buildTools();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const msg = `plugin '${manifest.id}' buildTools() threw: ${errMsg}`;
      this._warn(manifest.id, msg);
      return this._degradedPlugin(manifest, msg);
    }

    const toolMap = new Map(tools.map((t) => [t.name, t]));

    const executeTool = async (
      toolName: string,
      input: unknown,
      ctx: PluginExecutionContext,
    ): Promise<PluginToolResult> => {
      const tool = toolMap.get(toolName);
      if (!tool) {
        return {
          status: "error",
          message: `tool '${toolName}' not found in plugin '${manifest.id}'`,
        };
      }
      return tool.execute(input, ctx);
    };

    return {
      manifest,
      executeTool,
      dispose: async () => {},
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _degradedPlugin(manifest: PluginManifest, reason: string): LoadedPlugin {
    return {
      manifest,
      executeTool: async () => ({
        status: "error",
        message: reason,
      }),
      dispose: async () => {},
    };
  }

  private _buildManifest(pj: PluginJson, rootPath: string): PluginManifest {
    return {
      id: pj.id,
      name: pj.name ?? pj.id,
      version: pj.version,
      description: pj.description,
      author: pj.author,
      sourceId: this.id,
      rootPath,
      tools: (pj.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        // Preserve the plugin's declared JSON Schema so the engine can
        // derive a matching raw shape (see src/engine/claude-agent-sdk.ts).
        // Default: empty object schema (no declared args).
        inputSchema: (t.inputSchema ?? { type: "object" }) as { type: "object" },
        // Default requiredPermission: "exec" for shell plugins, "none" for
        // in-process. Plugin authors can override either per-tool.
        requiredPermission:
          t.requiredPermission ?? (pj.execMode === "shell" ? "exec" : "none"),
        command: [],
      })),
      execMode: pj.execMode,
      entryModule: pj.entryModule,
      // Attach command at manifest level for shell mode lookup.
      ...({ command: pj.command } as object),
    };
  }

  private _warn(pluginId: string, msg: string): void {
    process.stderr.write(`[openswarm] plugin ${pluginId}: ${msg}\n`);
  }
}
