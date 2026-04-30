/**
 * PluginStateStore — persists plugin enable/disable state, installed versions,
 * and install sources under a root directory (default: `~/.swarm-coder/plugins/`).
 *
 * Phase 1 / doc 17 Q1: two-file schema matching claw's shape.
 *   - `settings.json`  — enable map `{ [pluginId]: boolean }`.
 *   - `installed.json` — manifest registry `{ schemaVersion, plugins: { [id]: { version, installSource } } }`.
 *
 * A single `.lock` file in the root dir serializes writes across both files.
 * External callers see a unified `PluginStateFile` shape (see ./index.ts) —
 * the two-file split is an internal detail.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import lockfile from "proper-lockfile";
import type { PluginInstallSource, PluginStateFile } from "./index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_FILE = "settings.json";
const INSTALLED_FILE = "installed.json";
const LOCK_FILE = ".lock";

const DEFAULT_ROOT = path.join(os.homedir(), ".swarm-coder", "plugins");

// ---------------------------------------------------------------------------
// Internal file shapes
// ---------------------------------------------------------------------------

/** settings.json shape — matches claw's `{plugin_id: true|false}` map. */
type SettingsFileShape = Record<string, boolean>;

/** installed.json shape — manifest registry owned by swarm-coder. */
interface InstalledFileShape {
  readonly schemaVersion: 1;
  readonly plugins: Readonly<
    Record<string, { readonly version: string; readonly installSource: PluginInstallSource }>
  >;
}

const EMPTY_INSTALLED: InstalledFileShape = { schemaVersion: 1, plugins: {} };

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseSettings(raw: string, filePath: string): SettingsFileShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`settings.json is not valid JSON: ${filePath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`settings.json must be a JSON object: ${filePath}`);
  }
  const out: SettingsFileShape = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "boolean") {
      throw new Error(`settings.json value for '${k}' must be boolean: ${filePath}`);
    }
    out[k] = v;
  }
  return out;
}

function parseInstalled(raw: string, filePath: string): InstalledFileShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`installed.json is not valid JSON: ${filePath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`installed.json must be a JSON object: ${filePath}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new Error(
      `installed.json has unsupported schemaVersion ${String(obj.schemaVersion)}; expected 1`,
    );
  }
  const plugins = obj.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
    throw new Error(`installed.json 'plugins' field must be an object: ${filePath}`);
  }
  return parsed as InstalledFileShape;
}

// ---------------------------------------------------------------------------
// PluginStateStore
// ---------------------------------------------------------------------------

export class PluginStateStore {
  private readonly rootDir: string;
  private readonly settingsPath: string;
  private readonly installedPath: string;
  private readonly lockPath: string;

  /**
   * @param rootDir Root directory for plugin state files. Defaults to
   *                `~/.swarm-coder/plugins/`. Tests typically pass a tmpdir.
   */
  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? DEFAULT_ROOT;
    this.settingsPath = path.join(this.rootDir, SETTINGS_FILE);
    this.installedPath = path.join(this.rootDir, INSTALLED_FILE);
    this.lockPath = path.join(this.rootDir, LOCK_FILE);
  }

  // ---------------------------------------------------------------------------
  // read — merged view over settings.json + installed.json
  // ---------------------------------------------------------------------------

  async read(): Promise<PluginStateFile> {
    const [settings, installed] = await Promise.all([
      this._readSettings(),
      this._readInstalled(),
    ]);
    const enabled: string[] = [];
    const versions: Record<string, string> = {};
    const installSources: Record<string, PluginInstallSource> = {};

    for (const [id, entry] of Object.entries(installed.plugins)) {
      versions[id] = entry.version;
      installSources[id] = entry.installSource;
      if (settings[id] === true) enabled.push(id);
    }

    return {
      schemaVersion: 1,
      enabled,
      versions,
      installSources,
    };
  }

  async isEnabled(id: string): Promise<boolean> {
    const settings = await this._readSettings();
    return settings[id] === true;
  }

  // ---------------------------------------------------------------------------
  // write — lock-guarded atomic write of both files
  // ---------------------------------------------------------------------------

  async write(state: PluginStateFile): Promise<void> {
    await this._lockedMutate(() => state);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this._lockedMutate((state) => {
      if (!(id in state.versions)) {
        throw new Error(
          `cannot ${enabled ? "enable" : "disable"} plugin '${id}': not installed`,
        );
      }
      const alreadyEnabled = state.enabled.includes(id);
      if (enabled && alreadyEnabled) return state;
      if (!enabled && !alreadyEnabled) return state;

      const newEnabled = enabled
        ? [...state.enabled, id]
        : state.enabled.filter((x) => x !== id);

      return { ...state, enabled: newEnabled };
    });
  }

  async record(
    id: string,
    version: string,
    source: PluginInstallSource,
  ): Promise<void> {
    await this._lockedMutate((state) => {
      const newEnabled = state.enabled.includes(id)
        ? state.enabled
        : [...state.enabled, id];
      return {
        ...state,
        enabled: newEnabled,
        versions: { ...state.versions, [id]: version },
        installSources: { ...state.installSources, [id]: source },
      };
    });
  }

  async remove(id: string): Promise<void> {
    await this._lockedMutate((state) => {
      const newEnabled = state.enabled.filter((x) => x !== id);
      const newVersions = { ...state.versions };
      delete newVersions[id];
      const newSources = { ...state.installSources };
      delete newSources[id];
      return {
        ...state,
        enabled: newEnabled,
        versions: newVersions,
        installSources: newSources,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async _readSettings(): Promise<SettingsFileShape> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      return parseSettings(raw, this.settingsPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  private async _readInstalled(): Promise<InstalledFileShape> {
    try {
      const raw = await fs.readFile(this.installedPath, "utf8");
      return parseInstalled(raw, this.installedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_INSTALLED;
      throw err;
    }
  }

  private async _ensureLockTarget(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    try {
      await fs.access(this.lockPath);
    } catch {
      // Race-safe: another process may create this between our access() and writeFile().
      await fs.writeFile(this.lockPath, "", { flag: "wx" }).catch(() => {});
    }
  }

  private _stateToSettings(state: PluginStateFile): SettingsFileShape {
    const out: SettingsFileShape = {};
    // Only emit entries for installed plugins. `true` when enabled, `false` when not.
    for (const id of Object.keys(state.versions)) {
      out[id] = state.enabled.includes(id);
    }
    return out;
  }

  private _stateToInstalled(state: PluginStateFile): InstalledFileShape {
    const plugins: Record<
      string,
      { version: string; installSource: PluginInstallSource }
    > = {};
    for (const id of Object.keys(state.versions)) {
      const version = state.versions[id];
      const installSource = state.installSources[id];
      if (version === undefined || installSource === undefined) continue;
      plugins[id] = { version, installSource };
    }
    return { schemaVersion: 1, plugins };
  }

  private async _writeAtomic(target: string, content: string): Promise<void> {
    const nonce = crypto.randomBytes(4).toString("hex");
    const tmp = `${target}.tmp.${process.pid}.${nonce}`;
    const fd = await fs.open(tmp, "wx");
    try {
      await fd.writeFile(content, "utf8");
    } finally {
      await fd.close();
    }
    try {
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async _lockedMutate(
    mutator: (state: PluginStateFile) => PluginStateFile,
  ): Promise<void> {
    await this._ensureLockTarget();

    const release = await lockfile.lock(this.lockPath, {
      retries: { retries: 5, factor: 2, minTimeout: 50 },
      stale: 30_000,
    });

    try {
      const current = await this.read();
      const next = mutator(current);

      const settings = this._stateToSettings(next);
      const installed = this._stateToInstalled(next);

      await this._writeAtomic(
        this.installedPath,
        JSON.stringify(installed, null, 2),
      );
      await this._writeAtomic(
        this.settingsPath,
        JSON.stringify(settings, null, 2),
      );
    } finally {
      await release();
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton (lazy)
// ---------------------------------------------------------------------------

let _defaultStore: PluginStateStore | null = null;

export function defaultStore(): PluginStateStore {
  if (!_defaultStore) {
    _defaultStore = new PluginStateStore();
  }
  return _defaultStore;
}
