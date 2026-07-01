/**
 * bootstrap.ts — docs/44 P5 (H0). Read the bootstrap contract OpenHive's
 * hosting provider passes to a spawned swarm via environment variables.
 *
 * Contract (from OpenHive's local provider):
 *   - SWARM_RUNNER_BOOTSTRAP_TOKEN  base64(JSON) — opaque token; may carry an
 *                                   inline `openteams` team manifest (Path B).
 *   - SWARM_RUNNER_DATA_DIR         per-spawn data directory (state lives here).
 *   - MACRO_BOOTSTRAP_COORDINATOR="true"  spawn a default coordinator on boot.
 *   - MACRO_BOOTSTRAP_CWD        working dir for the bootstrap coordinator.
 *   - MACRO_BOOTSTRAP_REHYDRATE  "none" | "coordinators" | "all" — restart
 *                                revival policy (hosted swarms pass "all").
 *
 * Legacy `OPENSWARM_*` and swarm-harness-prefixed aliases are accepted as
 * equivalents so older hosts keep working during the namespace migration.
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
}

function firstEnv(
  env: NodeJS.ProcessEnv,
  ...keys: readonly string[]
): string | undefined {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** Parse the bootstrap contract from the environment. Never throws. */
export function readBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapConfig {
  let token: Record<string, unknown> | undefined;
  const rawToken = firstEnv(
    env,
    "SWARM_RUNNER_BOOTSTRAP_TOKEN",
    "OPENSWARM_BOOTSTRAP_TOKEN",
    "SWARM_HARNESS_BOOTSTRAP_TOKEN",
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

  const coordinator =
    firstEnv(
      env,
      "MACRO_BOOTSTRAP_COORDINATOR",
      "SWARM_HARNESS_BOOTSTRAP_COORDINATOR",
    ) === "true";

  const rawRehydrate = firstEnv(
    env,
    "MACRO_BOOTSTRAP_REHYDRATE",
    "SWARM_HARNESS_BOOTSTRAP_REHYDRATE",
  );
  const rehydrate: RehydratePolicy =
    rawRehydrate === "none" ||
    rawRehydrate === "coordinators" ||
    rawRehydrate === "all"
      ? rawRehydrate
      : "coordinators";

  const dataDir = firstEnv(
    env,
    "SWARM_RUNNER_DATA_DIR",
    "OPENSWARM_DATA_DIR",
    "SWARM_HARNESS_DATA_DIR",
  );
  const coordinatorCwd = firstEnv(
    env,
    "MACRO_BOOTSTRAP_CWD",
    "SWARM_HARNESS_BOOTSTRAP_CWD",
  );

  return {
    ...(token !== undefined && { token }),
    ...(dataDir !== undefined && { dataDir }),
    coordinator,
    ...(coordinatorCwd !== undefined && { coordinatorCwd }),
    rehydrate,
  };
}
