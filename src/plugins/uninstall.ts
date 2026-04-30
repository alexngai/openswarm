/**
 * uninstallPlugin — removes the on-disk plugin directory and clears it from state.
 * Idempotent: if the plugin directory does not exist, proceeds to state cleanup.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pluginsDir, sanitizeId } from "./install.js";
import { PluginStateStore, defaultStore } from "./state.js";

export interface UninstallOptions {
  store?: PluginStateStore;
  /** Override the plugins root directory (for testing). */
  pluginsRoot?: string;
}

export async function uninstallPlugin(
  id: string,
  storeOrOptions?: PluginStateStore | UninstallOptions,
): Promise<void> {
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
  const isInstalled = id in state.versions;
  if (!isInstalled) {
    process.stderr.write(`[swarm-harness] plugin '${id}' is not installed\n`);
  }

  // Step 1: remove on-disk directory (ENOENT is OK)
  const sanitized = sanitizeId(id);
  const pluginPath = path.join(root, sanitized);
  await fs.rm(pluginPath, { recursive: true, force: true });

  // Step 2: update state
  await stateStore.remove(id);
}
