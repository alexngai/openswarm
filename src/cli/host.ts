/**
 * host.ts — docs/44 P5. CLI entry for `swarm-harness host --port N [--host H]`.
 *
 * Spawned by OpenHive's hosting provider as a child process (see
 * `references/openhive` local provider). Binds the 3-port stride, answers
 * `/health`, resolves the bootstrap contract from the environment, and stays
 * alive until SIGTERM/SIGINT (graceful shutdown).
 */

import { bootSwarmHost } from "../host/boot.js";
import { readBootstrapConfig } from "../host/bootstrap.js";
import { createTeamConnection } from "../acp/team-connection.js";
import type { CommonOpts } from "./argv.js";
import type { PermissionMode } from "../core/types.js";

export interface RunHostOptions {
  readonly port: number;
  readonly host?: string;
  readonly cwd?: string;
  readonly permissionMode?: PermissionMode;
  /** OpenHive `--adapter` value (accepted for compatibility; informational). */
  readonly adapter?: string;
}

/** Default CommonOpts for the hosted ACP coordinator team (headless, no TTY). */
function hostedAcpOpts(permissionMode: PermissionMode): CommonOpts {
  return {
    permissionMode,
    outputFormat: "json",
    headless: true,
    plugins: true,
    skills: true,
    mcp: true,
    hooks: true,
    dumpTools: false,
    enableWebSearch: false,
    framework: "auto",
  };
}

export async function runHost(opts: RunHostOptions): Promise<number> {
  const bootstrap = readBootstrapConfig();
  // The data dir (OPENSWARM_DATA_DIR) is where per-spawn state lives; default
  // the working dir to it so spawned agents operate in the hosted workspace.
  const cwd = opts.cwd ?? bootstrap.dataDir ?? process.cwd();
  const permissionMode = opts.permissionMode ?? "workspace-write";
  const acpOpts = hostedAcpOpts(permissionMode);

  let handle;
  try {
    handle = await bootSwarmHost({
      port: opts.port,
      ...(opts.host !== undefined && { host: opts.host }),
      cwd,
      bootstrap,
      permissionMode,
      // ACP-over-WebSocket on the base port: each client gets its own
      // coordinator team (docs/44 P6).
      acpFactory: (conn) => createTeamConnection(conn, acpOpts),
      // MAP server on base+2 so OpenHive can observe/control the swarm (P7).
      map: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[swarm-harness] host failed to start: ${msg}\n`);
    return 1;
  }

  if (opts.adapter !== undefined) {
    process.stderr.write(`[swarm-harness] adapter=${opts.adapter}\n`);
  }

  // Stay alive until a termination signal, then shut down gracefully.
  await new Promise<void>((resolve) => {
    const stop = (sig: NodeJS.Signals): void => {
      process.stderr.write(`[swarm-harness] ${sig} received; shutting down...\n`);
      resolve();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });

  await handle.shutdown();
  return 0;
}
