/**
 * installPlugin — materializes a plugin from a PluginInstallSource into
 * `~/.openswarm/plugins/<sanitized-id>/` and records it in PluginStateStore.
 *
 * Doc 17 Q1 (2026-04-22): openswarm owns `~/.openswarm/plugins/` and never
 * writes to `~/.claude/plugins/`. Plugins installed via Claude Code under
 * `~/.claude/plugins/` are surfaced through a separate read-only discovery
 * source (see src/cli/main.ts).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as cp from "node:child_process";
import type { PluginInstallSource } from "./index.js";
import { PluginStateStore, defaultStore } from "./state.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function pluginsDir(): string {
  return path.join(os.homedir(), ".openswarm", "plugins");
}

// ---------------------------------------------------------------------------
// Id sanitization
// ---------------------------------------------------------------------------

/** Validate and transform a plugin id to a safe filesystem directory name. */
export function sanitizeId(id: string): string {
  if (id.includes("..")) {
    throw new RangeError(
      `Plugin id must not contain path traversal sequences: ${id}`,
    );
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(id)) {
    throw new RangeError(
      `Plugin id contains disallowed characters: ${id}. ` +
        `Allowed: a-z A-Z 0-9 . _ / -`,
    );
  }
  return id.replace(/\//g, "--");
}

// ---------------------------------------------------------------------------
// Manifest schema (minimal validation)
// ---------------------------------------------------------------------------

interface PluginManifestJson {
  id: string;
  version: string;
  name: string;
  [key: string]: unknown;
}

export function validateManifest(raw: unknown, stagingPath: string): PluginManifestJson {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`plugin.json at ${stagingPath} is not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const field of ["id", "version", "name"] as const) {
    if (typeof obj[field] !== "string") {
      throw new Error(
        `plugin.json is missing required field '${field}' (must be a string)`,
      );
    }
  }
  return obj as unknown as PluginManifestJson;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface InstallResult {
  id: string;
  version: string;
  installedPath: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InstallOptions {
  store?: PluginStateStore;
  /** Override the plugins root directory (for testing). */
  pluginsRoot?: string;
}

// ---------------------------------------------------------------------------
// installPlugin
// ---------------------------------------------------------------------------

export async function installPlugin(
  source: PluginInstallSource,
  storeOrOptions?: PluginStateStore | InstallOptions,
): Promise<InstallResult> {
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

  const nonce = crypto.randomBytes(8).toString("hex");
  const stagingPath = path.join(root, ".staging", nonce);

  await fs.mkdir(stagingPath, { recursive: true });

  try {
    // Step 1: materialize source into staging
    if (source.kind === "LocalPath") {
      await fs.cp(source.path, stagingPath, { recursive: true });
    } else {
      const args = [
        "clone",
        "--depth",
        "1",
        ...(source.ref ? ["--branch", source.ref] : []),
        source.url,
        stagingPath,
      ];
      cp.execFileSync("git", args, { stdio: "pipe" });
    }

    // Step 2: read + validate manifest
    const manifestPath = path.join(stagingPath, "plugin.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch {
      throw new Error(
        `plugin.json not found in ${source.kind === "LocalPath" ? source.path : source.url}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`plugin.json is not valid JSON`);
    }

    const manifest = validateManifest(parsed, stagingPath);

    // Step 3: sanitize id
    const sanitized = sanitizeId(manifest.id);

    // Step 4: reject duplicates
    const state = await stateStore.read();
    if (manifest.id in state.versions) {
      throw new Error(
        `plugin '${manifest.id}' is already installed; use 'plugin update' to re-materialize`,
      );
    }

    // Step 5: atomic swap into plugins dir
    const dest = path.join(root, sanitized);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(stagingPath, dest);

    // Step 6: record in state
    await stateStore.record(manifest.id, manifest.version, source);

    return { id: manifest.id, version: manifest.version, installedPath: dest };
  } catch (err) {
    // Cleanup staging on any failure
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw err;
  }
}
