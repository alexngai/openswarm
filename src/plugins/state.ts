/**
 * PluginStateStore — persists plugin enable/disable state, installed versions,
 * and install sources to `~/.claude/plugins/state.json`.
 *
 * All writes are wrapped in a proper-lockfile acquire/release cycle to
 * serialize concurrent invocations (e.g. two simultaneous `plugin enable`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import lockfile from "proper-lockfile";
import type { PluginInstallSource, PluginStateFile } from "./index.js";

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

const DEFAULT_STATE: PluginStateFile = {
  schemaVersion: 1,
  enabled: [],
  versions: {},
  installSources: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseState(raw: string, filePath: string): PluginStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`state.json is not valid JSON: ${filePath}`);
  }
  const state = parsed as PluginStateFile;
  if (state.schemaVersion !== 1) {
    throw new Error(
      `state.json has unsupported schemaVersion ${state.schemaVersion}; expected 1`,
    );
  }
  return state;
}

async function readStateFile(filePath: string): Promise<PluginStateFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, enabled: [], versions: {}, installSources: {} };
    }
    throw err;
  }
  return parseState(raw, filePath);
}

// ---------------------------------------------------------------------------
// PluginStateStore
// ---------------------------------------------------------------------------

export class PluginStateStore {
  private readonly stateFile: string;

  constructor(stateFile?: string) {
    this.stateFile = stateFile ?? path.join(os.homedir(), ".claude", "plugins", "state.json");
  }

  // ---------------------------------------------------------------------------
  // read
  // ---------------------------------------------------------------------------

  async read(): Promise<PluginStateFile> {
    return readStateFile(this.stateFile);
  }

  // ---------------------------------------------------------------------------
  // write — lock-guarded atomic write
  // ---------------------------------------------------------------------------

  async write(state: PluginStateFile): Promise<void> {
    await this._lockedWrite(state);
  }

  // ---------------------------------------------------------------------------
  // _lockedWrite — internal: ensure file exists, acquire lock, write atomically
  // ---------------------------------------------------------------------------

  private async _lockedWrite(state: PluginStateFile): Promise<void> {
    const dir = path.dirname(this.stateFile);
    await fs.mkdir(dir, { recursive: true });

    // Ensure the state file exists before locking (proper-lockfile requires it).
    try {
      await fs.access(this.stateFile);
    } catch {
      // File doesn't exist — create it. Race-safe: use "wx" (O_CREAT|O_EXCL).
      await fs.writeFile(this.stateFile, JSON.stringify(DEFAULT_STATE), { flag: "wx" }).catch(
        () => {
          // Another process beat us to it — that's fine.
        },
      );
    }

    const release = await lockfile.lock(this.stateFile, {
      retries: { retries: 5, factor: 2, minTimeout: 50 },
      stale: 30_000,
    });

    const nonce = crypto.randomBytes(4).toString("hex");
    const tmp = `${this.stateFile}.tmp.${process.pid}.${nonce}`;

    try {
      // Open with O_CREAT | O_EXCL | O_WRONLY ("wx") for NFS-safety.
      const fd = await fs.open(tmp, "wx");
      try {
        await fd.writeFile(JSON.stringify(state, null, 2), "utf8");
      } finally {
        await fd.close();
      }
      await fs.rename(tmp, this.stateFile);
    } finally {
      await release();
      // Clean up tmp if rename failed.
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // _lockedMutate — read-inside-lock → mutate → write (prevents concurrent races)
  // ---------------------------------------------------------------------------

  private async _lockedMutate(
    mutator: (state: PluginStateFile) => PluginStateFile,
  ): Promise<void> {
    const dir = path.dirname(this.stateFile);
    await fs.mkdir(dir, { recursive: true });

    // Ensure the state file exists before locking.
    try {
      await fs.access(this.stateFile);
    } catch {
      await fs.writeFile(this.stateFile, JSON.stringify(DEFAULT_STATE), { flag: "wx" }).catch(
        () => {},
      );
    }

    const release = await lockfile.lock(this.stateFile, {
      retries: { retries: 5, factor: 2, minTimeout: 50 },
      stale: 30_000,
    });

    const nonce = crypto.randomBytes(4).toString("hex");
    const tmp = `${this.stateFile}.tmp.${process.pid}.${nonce}`;

    try {
      // Read current state inside the lock.
      const current = await readStateFile(this.stateFile);
      const next = mutator(current);

      // Write atomically.
      const fd = await fs.open(tmp, "wx");
      try {
        await fd.writeFile(JSON.stringify(next, null, 2), "utf8");
      } finally {
        await fd.close();
      }
      await fs.rename(tmp, this.stateFile);
    } finally {
      await release();
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // isEnabled
  // ---------------------------------------------------------------------------

  async isEnabled(id: string): Promise<boolean> {
    const state = await this.read();
    return state.enabled.includes(id);
  }

  // ---------------------------------------------------------------------------
  // setEnabled
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // record
  // ---------------------------------------------------------------------------

  async record(id: string, version: string, source: PluginInstallSource): Promise<void> {
    await this._lockedMutate((state) => {
      const newEnabled = state.enabled.includes(id) ? state.enabled : [...state.enabled, id];
      return {
        ...state,
        enabled: newEnabled,
        versions: { ...state.versions, [id]: version },
        installSources: { ...state.installSources, [id]: source },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------

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
