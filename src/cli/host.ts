/**
 * host.ts — docs/44 P5. CLI entry for `openswarm host --port N [--host H]`.
 *
 * Spawned by OpenHive's hosting provider as a child process (see
 * `references/openhive` local provider). Binds the 3-port stride, answers
 * `/health`, resolves the bootstrap contract from the environment, and stays
 * alive until SIGTERM/SIGINT (graceful shutdown).
 */

import { bootSwarmHost } from "../host/boot.js";
import { readBootstrapConfig, type BootstrapConfig } from "../host/bootstrap.js";
import { createTeamConnection } from "../acp/team-connection.js";
import type { CommonOpts } from "./argv.js";
import type { PermissionMode } from "../core/types.js";
import type { SandboxPolicy } from "../tools/tier0/sandbox.js";

export interface RunHostOptions {
  readonly port: number;
  readonly host?: string;
  readonly cwd?: string;
  readonly permissionMode?: PermissionMode;
  readonly sandbox?: SandboxPolicy;
  /** OpenHive `--adapter` value (accepted for compatibility; informational). */
  readonly adapter?: string;
  /** docs/44 Case 2 — outbound MAP: dial this hub instead of waiting to be dialed. */
  readonly mapServer?: string;
  readonly mapScope?: string;
  readonly onboardToken?: string;
  readonly model?: string;
}

/**
 * Turn an OpenHive hub base URL (`http[s]://host:port`) into the `/ws/map`
 * WebSocket URL the swarm dials, carrying `swarm_id` + `token` as query params.
 * This is exactly the contract OpenHive's `/ws/map` gate expects (see openhive
 * `src/map/ws-map.ts`: open mode keys the inbound swarm on `?swarm_id=` via
 * `resolveSwarmOpen`; both trust models authenticate via `?token=`).
 */
export function buildHubMapUrl(
  hubUrl: string,
  params: { swarmId?: string; token?: string } = {},
): string {
  const wsBase = hubUrl
    .replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`)
    .replace(/\/+$/, "");
  const url = new URL(wsBase.endsWith("/ws/map") ? wsBase : `${wsBase}/ws/map`);
  if (params.swarmId !== undefined && params.swarmId !== "") {
    url.searchParams.set("swarm_id", params.swarmId);
  }
  if (params.token !== undefined && params.token !== "") {
    url.searchParams.set("token", params.token);
  }
  return url.toString();
}

/**
 * Decide where the host's outbound MAP sidecar should dial.
 *
 *   1. An explicit `--map-server` / `OPENSWARM_MAP_SERVER` wins verbatim.
 *   2. Otherwise, if OpenHive spawned us, the hub URL + onboard credential +
 *      stable swarm id are inside `OPENSWARM_BOOTSTRAP_TOKEN` — derive the
 *      `/ws/map` target from them. This is what makes a plain
 *      `swarm_runner_command: 'openswarm host'` register itself with the hub.
 *   3. No hub anywhere → no sidecar (standalone host, unchanged).
 */
export function resolveHostMapTarget(
  bootstrap: BootstrapConfig,
  opts: Pick<RunHostOptions, "mapServer" | "mapScope" | "onboardToken">,
): { mapServer?: string; mapScope?: string; onboardToken?: string } {
  if (opts.mapServer !== undefined && opts.mapServer !== "") {
    return {
      mapServer: opts.mapServer,
      ...(opts.mapScope !== undefined && { mapScope: opts.mapScope }),
      ...(opts.onboardToken !== undefined && { onboardToken: opts.onboardToken }),
    };
  }
  if (bootstrap.hubUrl === undefined) {
    return {
      ...(opts.mapScope !== undefined && { mapScope: opts.mapScope }),
      ...(opts.onboardToken !== undefined && { onboardToken: opts.onboardToken }),
    };
  }
  const onboardToken = opts.onboardToken ?? bootstrap.onboardToken;
  const mapServer = buildHubMapUrl(bootstrap.hubUrl, {
    ...(bootstrap.swarmId !== undefined && { swarmId: bootstrap.swarmId }),
    ...(onboardToken !== undefined && { token: onboardToken }),
  });
  const mapScope =
    opts.mapScope ??
    (bootstrap.swarmId !== undefined ? `swarm:${bootstrap.swarmId}` : undefined);
  return {
    mapServer,
    ...(mapScope !== undefined && { mapScope }),
    ...(onboardToken !== undefined && { onboardToken }),
  };
}

/** Redact the `token` query param before logging a hub URL. */
function redactToken(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) u.searchParams.set("token", "***");
    return u.toString();
  } catch {
    return url;
  }
}

/** Default CommonOpts for the hosted ACP coordinator team (headless, no TTY). */
function hostedAcpOpts(
  permissionMode: PermissionMode,
  sandbox: SandboxPolicy,
  model?: string,
): CommonOpts {
  return {
    permissionMode,
    sandbox,
    ...(model !== undefined && { model }),
    outputFormat: "json",
    headless: true,
    plugins: true,
    skills: true,
    mcp: true,
    hooks: true,
    dumpTools: false,
    enableWebSearch: false,
    plan: false,
    framework: "auto",
  };
}

export async function runHost(opts: RunHostOptions): Promise<number> {
  const bootstrap = readBootstrapConfig();
  // The data dir is where per-spawn state lives; default the working dir to it
  // so spawned agents operate in the hosted workspace.
  const cwd = opts.cwd ?? bootstrap.dataDir ?? process.cwd();
  const permissionMode = opts.permissionMode ?? "workspace-write";
  const acpOpts = hostedAcpOpts(permissionMode, opts.sandbox ?? "prefer", opts.model);

  // Where to dial for the outbound MAP sidecar: an explicit --map-server, else
  // the hub coordinates carried in the OpenHive bootstrap token.
  const mapTarget = resolveHostMapTarget(bootstrap, {
    ...(opts.mapServer !== undefined && { mapServer: opts.mapServer }),
    ...(opts.mapScope !== undefined && { mapScope: opts.mapScope }),
    ...(opts.onboardToken !== undefined && { onboardToken: opts.onboardToken }),
  });
  if (mapTarget.mapServer !== undefined && opts.mapServer === undefined) {
    process.stderr.write(
      `[openswarm] dialing hub from bootstrap token: ${redactToken(mapTarget.mapServer)}\n`,
    );
  }

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
      // docs/44 Case 2 — outbound MAP sidecar + ACP-over-MAP. The target is
      // either an explicit --map-server or derived from the bootstrap token so
      // an OpenHive-spawned `openswarm host` dials back in and registers.
      ...(mapTarget.mapServer !== undefined && { mapServer: mapTarget.mapServer }),
      ...(mapTarget.mapScope !== undefined && { mapScope: mapTarget.mapScope }),
      ...(mapTarget.onboardToken !== undefined && { onboardToken: mapTarget.onboardToken }),
      // Register under the hub's pre-registered swarm identity when known.
      ...(bootstrap.swarmId !== undefined && { swarmId: bootstrap.swarmId }),
      acpTeamOpts: acpOpts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[openswarm] host failed to start: ${msg}\n`);
    return 1;
  }

  if (opts.adapter !== undefined) {
    process.stderr.write(`[openswarm] adapter=${opts.adapter}\n`);
  }

  // Stay alive until a termination signal, then shut down gracefully.
  await new Promise<void>((resolve) => {
    const stop = (sig: NodeJS.Signals): void => {
      process.stderr.write(`[openswarm] ${sig} received; shutting down...\n`);
      resolve();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });

  await handle.shutdown();
  return 0;
}
