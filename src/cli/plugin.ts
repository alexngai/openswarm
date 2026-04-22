/**
 * plugin CLI subcommand — install/list/enable/disable/update/uninstall.
 *
 * Entry point: `pluginMain(argv, store?, pluginsRoot?)` returns an exit code.
 * main.ts (Phase 7) wires this in; do not import from main.ts here.
 *
 * Exit codes:
 *   0 — success
 *   1 — user error (bad args, not installed, path not found, etc.)
 *   2 — infra error (unexpected throws)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { installPlugin } from "../plugins/install.js";
import { enablePlugin } from "../plugins/enable.js";
import { disablePlugin } from "../plugins/disable.js";
import { updatePlugin } from "../plugins/update.js";
import { uninstallPlugin } from "../plugins/uninstall.js";
import { PluginStateStore, defaultStore } from "../plugins/state.js";
import type { PluginInstallSource } from "../plugins/index.js";

// ---------------------------------------------------------------------------
// resolveInstallSource
// ---------------------------------------------------------------------------

export function resolveInstallSource(raw: string): PluginInstallSource {
  if (
    raw.startsWith("git+") ||
    /\.git($|[#?])/.test(raw) ||
    raw.startsWith("git@")
  ) {
    return { kind: "GitUrl", url: raw };
  }

  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `plugin install source not recognized: "${raw}". ` +
        `Supply a path to an existing directory, or a git URL ` +
        `(ending in .git or starting with git+/git@).`,
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`plugin install source must be a directory: ${raw}`);
  }
  return { kind: "LocalPath", path: resolved };
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function cmdInstall(
  args: string[],
  store: PluginStateStore,
  pluginsRoot?: string,
): Promise<number> {
  const sourceRaw = args[0];
  if (!sourceRaw) {
    process.stderr.write("Usage: plugin install <source>\n");
    return 1;
  }

  const trustFlag = args.includes("--yes-i-trust-this-source");

  let source: PluginInstallSource;
  try {
    source = resolveInstallSource(sourceRaw);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }

  // Safety gate for git URLs.
  if (source.kind === "GitUrl" && !trustFlag) {
    process.stderr.write(
      `Warning: installing from untrusted source; this will run code from the manifest's command field.\n` +
        `Re-run with --yes-i-trust-this-source to proceed.\n`,
    );
    return 1;
  }

  try {
    const result = await installPlugin(source, { store, pluginsRoot });
    process.stdout.write(
      `Installed '${result.id}' v${result.version} → ${result.installedPath}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return err instanceof RangeError ? 1 : 2;
  }
}

async function cmdList(store: PluginStateStore): Promise<number> {
  try {
    const state = await store.read();
    const ids = Object.keys(state.versions);

    if (ids.length === 0) {
      process.stdout.write("No plugins installed.\n");
      return 0;
    }

    // Table header
    process.stdout.write(
      `${"id".padEnd(30)} ${"version".padEnd(12)} ${"enabled".padEnd(8)} source\n`,
    );
    process.stdout.write(
      `${"-".repeat(30)} ${"-".repeat(12)} ${"-".repeat(8)} ${"-".repeat(30)}\n`,
    );

    for (const id of ids) {
      const version = state.versions[id] ?? "?";
      const enabled = state.enabled.includes(id) ? "yes" : "no";
      const src = state.installSources[id];
      const srcStr = src
        ? src.kind === "LocalPath"
          ? src.path
          : src.url
        : "unknown";
      process.stdout.write(
        `${id.padEnd(30)} ${version.padEnd(12)} ${enabled.padEnd(8)} ${srcStr}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 2;
  }
}

async function cmdEnable(id: string, store: PluginStateStore): Promise<number> {
  try {
    await enablePlugin(id, store);
    process.stdout.write(`Plugin '${id}' enabled.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdDisable(id: string, store: PluginStateStore): Promise<number> {
  try {
    await disablePlugin(id, store);
    process.stdout.write(`Plugin '${id}' disabled.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdUpdate(
  id: string,
  store: PluginStateStore,
  pluginsRoot?: string,
): Promise<number> {
  try {
    const result = await updatePlugin(id, { store, pluginsRoot });
    process.stdout.write(
      `Updated '${result.id}': ${result.oldVersion} → ${result.newVersion}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdUninstall(
  id: string,
  store: PluginStateStore,
  pluginsRoot?: string,
): Promise<number> {
  try {
    await uninstallPlugin(id, { store, pluginsRoot });
    process.stdout.write(`Plugin '${id}' uninstalled.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function pluginMain(
  argv: string[],
  store?: PluginStateStore,
  pluginsRoot?: string,
): Promise<number> {
  const stateStore = store ?? defaultStore();
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case "install":
      return cmdInstall(rest, stateStore, pluginsRoot);

    case "list":
      return cmdList(stateStore);

    case "enable": {
      const id = rest[0];
      if (!id) {
        process.stderr.write("Usage: plugin enable <id>\n");
        return 1;
      }
      return cmdEnable(id, stateStore);
    }

    case "disable": {
      const id = rest[0];
      if (!id) {
        process.stderr.write("Usage: plugin disable <id>\n");
        return 1;
      }
      return cmdDisable(id, stateStore);
    }

    case "update": {
      const id = rest[0];
      if (!id) {
        process.stderr.write("Usage: plugin update <id>\n");
        return 1;
      }
      return cmdUpdate(id, stateStore, pluginsRoot);
    }

    case "uninstall": {
      const id = rest[0];
      if (!id) {
        process.stderr.write("Usage: plugin uninstall <id>\n");
        return 1;
      }
      return cmdUninstall(id, stateStore, pluginsRoot);
    }

    default:
      process.stderr.write(
        `Unknown plugin subcommand: ${subcommand ?? "(none)"}\n` +
          `Usage: plugin <install|list|enable|disable|update|uninstall> [args]\n`,
      );
      return 1;
  }
}
