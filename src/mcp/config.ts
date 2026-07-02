/**
 * MCP config loader (rev-2 Major M8).
 *
 * Hierarchy (first-match-wins):
 *   1. `$OPENSWARM_CONFIG_DIR/mcp.json`
 *   2. `<cwd>/.openswarm/mcp.json`
 *   3. `<cwd>/.claude/mcp_servers.json`                (Claude Code compat)
 *   4. `$HOME/.claude/mcp_servers.json`                (Claude Code compat)
 *
 * JSON shape (compatible with Claude Code):
 *   {
 *     "mcpServers": {
 *       "<server-name>": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
 *         "env": { "X": "Y" },
 *         "cwd": "/optional"
 *       }
 *     }
 *   }
 *
 * Missing config at every location → returns an empty list silently.
 * Malformed JSON at the first matched path → throws a clean error.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { McpServerConfig } from "./client.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ServerSpecSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const McpConfigFileSchema = z.object({
  mcpServers: z.record(z.string(), ServerSpecSchema).optional(),
});

// ---------------------------------------------------------------------------
// Options + result types
// ---------------------------------------------------------------------------

export interface LoadMcpConfigOptions {
  readonly cwd?: string;
  readonly homedir?: string;
  readonly envOverrides?: NodeJS.ProcessEnv;
}

export interface LoadedMcpConfig {
  readonly configs: McpServerConfig[];
  readonly resolvedPath?: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolve the first matching config path from the hierarchy. Absent files are
 * silently skipped; the first one that exists wins.
 *
 * Returns undefined when none of the paths exist.
 */
function resolveConfigPath(opts: LoadMcpConfigOptions): string | undefined {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homedir ?? os.homedir();
  const env = opts.envOverrides ?? process.env;

  const candidates: string[] = [];

  const envDir = env.OPENSWARM_CONFIG_DIR;
  if (envDir && envDir.length > 0) {
    candidates.push(path.join(envDir, "mcp.json"));
  }
  candidates.push(path.join(cwd, ".openswarm", "mcp.json"));
  candidates.push(path.join(cwd, ".claude", "mcp_servers.json"));
  candidates.push(path.join(home, ".claude", "mcp_servers.json"));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore fs errors — treat as non-existent
    }
  }
  return undefined;
}

/**
 * Load the MCP config from the hierarchy.
 * Emits a short stderr line identifying the resolved path (or absence).
 */
export async function loadMcpConfig(
  opts: LoadMcpConfigOptions = {},
): Promise<LoadedMcpConfig> {
  const resolvedPath = resolveConfigPath(opts);
  if (resolvedPath === undefined) {
    return { configs: [] };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(
      `mcp config: failed to read ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `mcp config: ${resolvedPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = McpConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `mcp config: ${resolvedPath} schema validation failed: ${result.error.message}`,
    );
  }

  const servers = result.data.mcpServers ?? {};
  const configs: McpServerConfig[] = Object.entries(servers).map(
    ([name, spec]): McpServerConfig => ({
      name,
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
    }),
  );

  return { configs, resolvedPath };
}
