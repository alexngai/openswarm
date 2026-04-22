/**
 * disablePlugin — marks a plugin as disabled in the persisted state.
 * Throws if the plugin is not installed (not in state.versions).
 */

import { PluginStateStore, defaultStore } from "./state.js";

export async function disablePlugin(id: string, store?: PluginStateStore): Promise<void> {
  await (store ?? defaultStore()).setEnabled(id, false);
}
