/**
 * team.ts — implementation of `swarm-harness team start <template>`.
 *
 * v0.4 stage 4F: minimal CLI surface that loads an openteams template,
 * maps it to a TeamSpec, and runs it through the Orchestrator. Full CLI
 * surface (`team send`, `team list`, `team stop`, `--map`) lands in 4K.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { PermissionMode } from "../core/types.js";
import { Orchestrator } from "../swarm/orchestrator.js";
import { loadTemplate } from "../swarm/openteams/loader.js";
import { openteamsToTeamSpec } from "../swarm/openteams/mapping.js";
import { MapAdapter } from "../swarm/adapters/map-adapter.js";
import type { MapClientFactory } from "../swarm/adapters/map-protocol.js";
import { TeamSpecSchema, type TeamSpec, type TopologyKind } from "../swarm/team-spec.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TeamStartOptions {
  readonly permissionMode: PermissionMode;
  readonly concurrency: number;
  /** Results JSONL file. Default upstream of here: ./results.jsonl */
  readonly output: string;
  /** Override openteams binary (testing). */
  readonly openteamsBinary?: string;
  /** Read template from a fixture dir instead of shelling out (testing). */
  readonly fixtureDir?: string;
  /**
   * v0.4 stage 4J: when set, the orchestrator wires a MapAdapter that
   * forwards a curated subset of lane events to a MAP-protocol observer at
   * this URL. Off when undefined — MAP SDK is never imported.
   */
  readonly mapUrl?: string;
  /**
   * Test-only override: inject a fake MapClientFactory instead of dynamically
   * importing `@multi-agent-protocol/sdk`. When unset and `mapUrl` is set,
   * the production factory is built via dynamic import.
   */
  readonly mapFactory?: MapClientFactory;
}

// ---------------------------------------------------------------------------
// runTeamStart
// ---------------------------------------------------------------------------

export async function runTeamStart(
  templateName: string,
  opts: TeamStartOptions,
): Promise<number> {
  // 1. Load openteams template.
  let config;
  try {
    config = await loadTemplate(templateName, {
      ...(opts.openteamsBinary !== undefined && {
        openteamsBinary: opts.openteamsBinary,
      }),
      ...(opts.fixtureDir !== undefined && { fixtureDir: opts.fixtureDir }),
    });
  } catch (err) {
    process.stderr.write(
      `error: failed to load template "${templateName}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // 2. Map to TeamSpec.
  let spec;
  try {
    spec = openteamsToTeamSpec(config);
  } catch (err) {
    process.stderr.write(
      `error: failed to map template "${templateName}" to TeamSpec: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // 3. Optional MAP adapter (v0.4 stage 4J — observability).
  // Only constructed when `--map` was passed. Production path lazy-imports
  // `@multi-agent-protocol/sdk`; tests pass an in-memory factory.
  let mapAdapter: MapAdapter | undefined;
  if (opts.mapUrl !== undefined) {
    const factory = opts.mapFactory ?? (await buildMapFactory());
    if (factory === undefined) {
      // SDK not installed and no test factory injected — surface a clear
      // error and exit 2. The dynamic-import error message has already been
      // written to stderr inside buildMapFactory().
      return 2;
    }
    mapAdapter = new MapAdapter({
      url: opts.mapUrl,
      teamName: spec.name,
      factory,
    });
  }

  // 4. Open results stream + orchestrator.
  const resultsOut = fs.createWriteStream(opts.output, { flags: "a" });
  const orch = new Orchestrator({
    concurrency: opts.concurrency,
    permissionMode: opts.permissionMode,
    resultsOut,
    eventsOut: process.stderr,
    ...(mapAdapter !== undefined && { mapAdapter }),
  });

  // 5. Run.
  const startedAt = Date.now();
  const result = await orch.runTeam(spec);
  const elapsed = Date.now() - startedAt;

  await new Promise<void>((resolve) => resultsOut.end(resolve));

  process.stderr.write(
    `[swarm-harness] team "${spec.name}" complete in ${elapsed}ms: ` +
      `${result.succeeded} succeeded, ${result.failed} failed, ${result.timeout} timeout, ${result.cancelled} cancelled\n`,
  );
  if (result.aggregateOutput !== undefined) {
    process.stdout.write(`${result.aggregateOutput}\n`);
  }

  return result.failed > 0 || result.timeout > 0 || result.cancelled > 0
    ? 1
    : 0;
}

// ---------------------------------------------------------------------------
// MAP SDK loader (v0.4 stage 4J)
// ---------------------------------------------------------------------------

/**
 * Lazy-load `@multi-agent-protocol/sdk` and adapt its AgentConnection API to
 * our `MapClientFactory` shim. When the package isn't installed, write a
 * helpful message to stderr and return undefined — caller exits 2.
 *
 * Pulled out as a module-level function so that simply importing team.ts
 * does not require the SDK to be present on disk.
 */
async function buildMapFactory(): Promise<MapClientFactory | undefined> {
  let sdk: unknown;
  try {
    // The package name is a literal string so bundlers don't try to resolve
    // it at build time. The dynamic import is also wrapped so a missing
    // package surfaces as a runtime error we can format cleanly.
    sdk = await import(
      /* @vite-ignore */ "@multi-agent-protocol/sdk" as string
    );
  } catch {
    process.stderr.write(
      "error: --map requires @multi-agent-protocol/sdk to be installed.\n" +
        "  Run: npm install @multi-agent-protocol/sdk\n",
    );
    return undefined;
  }
  // Duck-type the SDK's AgentConnection. Exact API surface verified at
  // runtime; we don't depend on its types at compile time.
  const sdkAny = sdk as {
    AgentConnection?: {
      connect: (opts: unknown) => Promise<{
        send: (method: string, params: unknown) => Promise<void>;
        notify: (method: string, params: unknown) => void;
        close: () => Promise<void>;
      }>;
    };
  };
  if (sdkAny.AgentConnection === undefined) {
    process.stderr.write(
      "error: @multi-agent-protocol/sdk did not export AgentConnection — incompatible version.\n",
    );
    return undefined;
  }
  const AgentConnection = sdkAny.AgentConnection;
  return {
    connect: async (opts) => {
      const conn = await AgentConnection.connect(opts);
      return {
        send: (method, params) => conn.send(method, params),
        notify: (method, params) => conn.notify(method, params),
        close: () => conn.close(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// runTopology (v0.4 stage 4K)
// ---------------------------------------------------------------------------

export interface TopologyRunOptions {
  readonly topologyKind: TopologyKind;
  readonly specPath: string;
  readonly permissionMode: PermissionMode;
  readonly concurrency: number;
  /** Results JSONL file. */
  readonly output: string;
  /** v0.4 stage 4J — optional MAP observability URL. */
  readonly mapUrl?: string;
  /** v0.4 stage 4K — test-only override mirroring TeamStartOptions. */
  readonly mapFactory?: MapClientFactory;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  /**
   * Test-only injection of a constructed Orchestrator. When set, runTopology
   * skips its own Orchestrator construction and calls `orch.runTeam(spec)`.
   * Used by team.test.ts to assert dispatch without spinning up workers.
   */
  readonly orchestrator?: Pick<Orchestrator, "runTeam">;
}

/**
 * Direct topology entry point: read a TeamSpec JSON file, override its
 * `topology` field with the CLI-provided kind, and run it through the
 * orchestrator. Mirrors the result-line writing pattern of `team start`.
 */
export async function runTopology(opts: TopologyRunOptions): Promise<number> {
  // 1. Read + parse spec.json.
  let raw: string;
  try {
    raw = await fsp.readFile(opts.specPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `error: failed to read spec file "${opts.specPath}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `error: spec file "${opts.specPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // Override `topology` with the CLI kind so a generic spec can be run as
  // any topology shape.
  const overlaid =
    typeof parsedJson === "object" && parsedJson !== null
      ? { ...(parsedJson as Record<string, unknown>), topology: opts.topologyKind }
      : parsedJson;

  const parseResult = TeamSpecSchema.safeParse(overlaid);
  if (!parseResult.success) {
    process.stderr.write(
      `error: spec file "${opts.specPath}" failed schema validation: ${parseResult.error.message}\n`,
    );
    return 2;
  }
  const spec = parseResult.data as TeamSpec;

  // Test path: caller injected an orchestrator stub. Run + return early.
  if (opts.orchestrator !== undefined) {
    const result = await opts.orchestrator.runTeam(spec);
    return result.failed > 0 || result.timeout > 0 || result.cancelled > 0
      ? 1
      : 0;
  }

  // 2. Optional MAP adapter (mirrors team start).
  let mapAdapter: MapAdapter | undefined;
  if (opts.mapUrl !== undefined) {
    const factory = opts.mapFactory ?? (await buildMapFactory());
    if (factory === undefined) return 2;
    mapAdapter = new MapAdapter({
      url: opts.mapUrl,
      teamName: spec.name,
      factory,
    });
  }

  // 3. Open results stream + orchestrator.
  const resultsOut = fs.createWriteStream(opts.output, { flags: "a" });
  const orch = new Orchestrator({
    concurrency: opts.concurrency,
    permissionMode: opts.permissionMode,
    resultsOut,
    eventsOut: process.stderr,
    ...(mapAdapter !== undefined && { mapAdapter }),
  });

  // 4. Run.
  const startedAt = Date.now();
  const result = await orch.runTeam(spec);
  const elapsed = Date.now() - startedAt;

  await new Promise<void>((resolve) => resultsOut.end(resolve));

  process.stderr.write(
    `[swarm-harness] topology ${opts.topologyKind} "${spec.name}" complete in ${elapsed}ms: ` +
      `${result.succeeded} succeeded, ${result.failed} failed, ${result.timeout} timeout, ${result.cancelled} cancelled\n`,
  );
  if (result.aggregateOutput !== undefined) {
    process.stdout.write(`${result.aggregateOutput}\n`);
  }

  return result.failed > 0 || result.timeout > 0 || result.cancelled > 0
    ? 1
    : 0;
}

// ---------------------------------------------------------------------------
// team send / list / stop / kill stubs (v0.4 stage 4K)
//
// These commands target a long-running orchestrator process for cross-process
// operations. v0.4 doesn't ship a team daemon — see docs/27 stage roadmap.
// Each stub prints a short, useful message pointing at the supported v0.4
// path (`team start <template>` / `topology <kind>`) and exits 2.
// ---------------------------------------------------------------------------

const DAEMON_DEFERRED_HINT =
  "Long-lived team daemons are deferred to v0.5+. " +
  "For v0.4 use 'team start <template>' or 'topology <kind> --spec <path>' " +
  "which run synchronously and exit when the team completes. " +
  "See docs/27-v0.4-teams-implementation-plan.md for the stage roadmap.";

export function runTeamSend(name: string, prompt: string): number {
  process.stderr.write(
    `error: 'team send' requires a long-running team daemon (target team: "${name}", prompt length: ${prompt.length}). ` +
      `${DAEMON_DEFERRED_HINT}\n`,
  );
  return 2;
}

export function runTeamList(): number {
  process.stderr.write(
    `error: 'team list' requires a long-running team daemon to enumerate. ` +
      `${DAEMON_DEFERRED_HINT}\n`,
  );
  return 2;
}

export function runTeamStop(name: string): number {
  process.stderr.write(
    `error: 'team stop' requires a long-running team daemon (target team: "${name}"). ` +
      `${DAEMON_DEFERRED_HINT}\n`,
  );
  return 2;
}

export function runTeamKill(name: string): number {
  process.stderr.write(
    `error: 'team kill' requires a long-running team daemon (target team: "${name}"). ` +
      `${DAEMON_DEFERRED_HINT}\n`,
  );
  return 2;
}
