/**
 * team.ts — implementation of `swarm-harness team start <template>`.
 *
 * v0.4 stage 4F: minimal CLI surface that loads an openteams template,
 * maps it to a TeamSpec, and runs it through the Orchestrator. Full CLI
 * surface (`team send`, `team list`, `team stop`, `--map`) lands in 4K.
 */

import * as fs from "node:fs";
import type { PermissionMode } from "../core/types.js";
import { Orchestrator } from "../swarm/orchestrator.js";
import { loadTemplate } from "../swarm/openteams/loader.js";
import { openteamsToTeamSpec } from "../swarm/openteams/mapping.js";
import { MapAdapter } from "../swarm/adapters/map-adapter.js";
import type { MapClientFactory } from "../swarm/adapters/map-protocol.js";

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
