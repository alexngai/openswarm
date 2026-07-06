/**
 * bootstrap.ts — docs/44 P5 (H0). Read the bootstrap contract OpenHive's
 * hosting provider passes to a spawned swarm via environment variables.
 *
 * Contract (from OpenHive's local provider, `src/swarm/providers/local.ts`):
 *   - OPENSWARM_BOOTSTRAP_TOKEN  base64(JSON) — the spawn token. Beyond an
 *                                optional inline `openteams` manifest (Path B),
 *                                it carries the fields the swarm needs to dial
 *                                the hub back: `openhive_url`, `onboard_token`,
 *                                `swarm_id`, `swarm_name` (built at OpenHive's
 *                                `manager.ts` bootstrapToken). We surface those
 *                                so `host` can open its outbound MAP sidecar
 *                                without an explicit `--map-server` flag.
 *   - OPENSWARM_DATA_DIR         per-spawn data directory (state lives here).
 *   - OPENSWARM_BOOTSTRAP_COORDINATOR="true"  spawn a default coordinator.
 *   - OPENSWARM_BOOTSTRAP_CWD    working dir for the bootstrap coordinator.
 *   - OPENSWARM_BOOTSTRAP_REHYDRATE  "none" | "coordinators" | "all" —
 *                                    restart revival policy.
 *
 * OpenHive-parity aliases: OpenHive's provider actually sets the coordinator
 * knobs under the `MACRO_BOOTSTRAP_*` names (macro-agent's bootV2 contract) and
 * duplicates the token/data-dir under `SWARM_RUNNER_*`. We accept both prefixes
 * so a plain `swarm_runner_command: 'openswarm host'` is a drop-in.
 */

export type RehydratePolicy = "none" | "coordinators" | "all";

export interface BootstrapConfig {
  /** Decoded bootstrap token (parsed JSON), if present + valid. */
  readonly token?: Record<string, unknown>;
  /** Per-spawn state directory. */
  readonly dataDir?: string;
  /** Whether to spawn a default coordinator on boot. */
  readonly coordinator: boolean;
  /** Working directory for the bootstrap coordinator (defaults to cwd). */
  readonly coordinatorCwd?: string;
  /** Restart revival policy. Defaults to "coordinators" (macro-agent default). */
  readonly rehydrate: RehydratePolicy;
  /**
   * OpenHive hub base URL from the token's `openhive_url` (e.g.
   * `http://127.0.0.1:7836`). When present, `host` derives the `/ws/map`
   * WebSocket URL and dials back in — no `--map-server` needed.
   */
  readonly hubUrl?: string;
  /** Delegated onboard credential from the token's `onboard_token` (verified hubs). */
  readonly onboardToken?: string;
  /** Stable swarm id from the token's `swarm_id` — the hub's pre-registered MAP identity. */
  readonly swarmId?: string;
  /** Human label from the token's `swarm_name`. */
  readonly swarmName?: string;
}

function firstEnv(
  env: NodeJS.ProcessEnv,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = env[key];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** Read a non-empty string field off the decoded token, else undefined. */
function tokenStr(
  token: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = token?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Parse the bootstrap contract from the environment. Never throws. */
export function readBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapConfig {
  let token: Record<string, unknown> | undefined;
  const rawToken = firstEnv(
    env,
    "OPENSWARM_BOOTSTRAP_TOKEN",
    "SWARM_RUNNER_BOOTSTRAP_TOKEN",
  );
  if (rawToken !== undefined) {
    try {
      const decoded = Buffer.from(rawToken, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        token = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed token is non-fatal — the swarm just boots without it.
    }
  }

  // Coordinator knobs: accept OpenHive's `MACRO_BOOTSTRAP_*` aliases too.
  const coordinator =
    firstEnv(
      env,
      "OPENSWARM_BOOTSTRAP_COORDINATOR",
      "MACRO_BOOTSTRAP_COORDINATOR",
    ) === "true";

  const rawRehydrate = firstEnv(
    env,
    "OPENSWARM_BOOTSTRAP_REHYDRATE",
    "MACRO_BOOTSTRAP_REHYDRATE",
  );
  const rehydrate: RehydratePolicy =
    rawRehydrate === "none" ||
    rawRehydrate === "coordinators" ||
    rawRehydrate === "all"
      ? rawRehydrate
      : "coordinators";

  const dataDir = firstEnv(env, "OPENSWARM_DATA_DIR", "SWARM_RUNNER_DATA_DIR");
  const coordinatorCwd = firstEnv(
    env,
    "OPENSWARM_BOOTSTRAP_CWD",
    "MACRO_BOOTSTRAP_CWD",
  );

  // Hub dial-back fields ride inside the token, not env vars.
  const hubUrl = tokenStr(token, "openhive_url");
  const onboardToken = tokenStr(token, "onboard_token");
  const swarmId = tokenStr(token, "swarm_id");
  const swarmName = tokenStr(token, "swarm_name");

  return {
    ...(token !== undefined && { token }),
    ...(dataDir !== undefined && { dataDir }),
    coordinator,
    ...(coordinatorCwd !== undefined && { coordinatorCwd }),
    rehydrate,
    ...(hubUrl !== undefined && { hubUrl }),
    ...(onboardToken !== undefined && { onboardToken }),
    ...(swarmId !== undefined && { swarmId }),
    ...(swarmName !== undefined && { swarmName }),
  };
}
