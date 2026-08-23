/**
 * updatePlugin — re-materializes an installed plugin from its recorded source,
 * atomically swaps the on-disk directory, and updates the version in state.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import { pluginsDir, sanitizeId, validateManifest } from "./install.js";
import { PluginStateStore, defaultStore } from "./state.js";
import type { PluginInstallSource } from "./index.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface UpdateResult {
  id: string;
  oldVersion: string;
  newVersion: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  store?: PluginStateStore;
  /** Override the plugins root directory (for testing). */
  pluginsRoot?: string;
}

// ---------------------------------------------------------------------------
// Materialize source into a directory
// ---------------------------------------------------------------------------

async function materialize(source: PluginInstallSource, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  if (source.kind === "LocalPath") {
    await fs.cp(source.path, dest, { recursive: true });
  } else {
    const args = [
      "clone",
      "--depth",
      "1",
      ...(source.ref ? ["--branch", source.ref] : []),
      source.url,
      dest,
    ];
    cp.execFileSync("git", args, { stdio: "pipe" });
  }
}

// ---------------------------------------------------------------------------
// updatePlugin
// ---------------------------------------------------------------------------

export async function updatePlugin(
  id: string,
  storeOrOptions?: PluginStateStore | UpdateOptions,
): Promise<UpdateResult> {
  // Normalise overloaded second arg.
  let stateStore: PluginStateStore;
  let root: string;

  if (storeOrOptions instanceof PluginStateStore) {
    stateStore = storeOrOptions;
    root = pluginsDir();
  } else if (storeOrOptions) {
    stateStore = storeOrOptions.store ?? defaultStore();
    root = storeOrOptions.pluginsRoot ?? pluginsDir();
  } else {
    stateStore = defaultStore();
    root = pluginsDir();
  }

  const state = await stateStore.read();

  if (!(id in state.installSources)) {
    throw new Error(`plugin '${id}' is not installed`);
  }

  const source = state.installSources[id]!;
  const oldVersion = state.versions[id] ?? "unknown";
  const sanitized = sanitizeId(id);
  const pluginPath = path.join(root, sanitized);

  const nonce = crypto.randomBytes(8).toString("hex");
  const stagingPath = path.join(root, `${sanitized}.new-${nonce}`);
  const oldPath = path.join(root, `${sanitized}.old`);

  try {
    // Step 1: materialize into staging
    await materialize(source, stagingPath);

    // Step 2: validate manifest
    const manifestPath = path.join(stagingPath, "plugin.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch {
      throw new Error(`plugin.json not found in staged update for '${id}'`);
    }
    const manifest = validateManifest(JSON.parse(raw), stagingPath);

    // Step 3: atomic swap
    // Rename current → .old
    await fs.rename(pluginPath, oldPath);
    try {
      // Rename staging → current
      await fs.rename(stagingPath, pluginPath);
    } catch (swapErr) {
      // Rollback: restore .old → current
      await fs.rename(oldPath, pluginPath).catch(() => {});
      await fs.rm(stagingPath, { recursive: true, force: true });
      throw swapErr;
    }

    // Remove .old
    await fs.rm(oldPath, { recursive: true, force: true });

    // Step 4: update state
    await stateStore.record(id, manifest.version, source);

    return { id, oldVersion, newVersion: manifest.version };
  } catch (err) {
    // Cleanup staging
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw err;
  }
}
